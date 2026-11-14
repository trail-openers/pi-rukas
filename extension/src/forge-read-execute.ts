/**
 * forge-read-execute — the verb table `forge_read` runs in the parent (#2160).
 *
 * One module holds the mapping from a read verb to the `Forge` method that
 * answers it, so the parent's executor is a table a test can walk verb by verb
 * rather than a switch buried in the socket server. The `Forge` object is built
 * through the seam (`buildForge`) so an offline test injects a fake and never
 * dials a forge.
 *
 * Every answer is raw bytes: the forge's own JSON, or the diff/log text. The
 * public-hygiene rewrite is a WRITE rule and is deliberately absent here (R9) —
 * a read publishes nothing, and rewriting a host path out of fetched bytes
 * corrupts what the caller is reviewing.
 *
 * A write verb never reaches this table: `validateForgeRead` refuses it before
 * the executor runs, and the table has no write row to reach.
 */

import { FORGE_LIST_LIMIT } from "./forge-commands.ts";
import type { ForgeDetection } from "./forge-detect.ts";
import { listRowCount } from "./forge-mapping.ts";
import type { ForgeReadRequest } from "./forge-read-tool.ts";
import { validateForgeRead } from "./forge-read-tool.ts";
import type { Forge } from "./forge-types.ts";
import { type CreateForgeOpts, createForge } from "./forge.ts";

/** The seam that turns a detection into a `Forge`. Tests replace it wholesale. */
export type BuildForge = (det: ForgeDetection, opts: CreateForgeOpts) => Forge;

const defaultBuildForge: BuildForge = (det, opts) => createForge(det, opts);

/**
 * What the caller of `executeForgeRead` may ask for.
 *
 * A named options bag, deliberately NOT the request object: this is the bag
 * that decides WHICH factory builds the forge the reads run through, and a
 * factory is a function that gets called. The broker passes this object
 * literally, built from its own config, so no value that came off the child's
 * socket can ever reach it. `timeoutMs` is the caller's bound; `buildForge`
 * exists for the offline tests and is unreachable from the wire.
 */
export interface ForgeReadExecuteOptions {
  timeoutMs?: number;
  buildForge?: BuildForge;
}

/**
 * Run one validated read against the parent's forge.
 *
 * Throws with the refusal reason for a malformed or write request — the broker
 * turns a throw into an `{ ok: false, reason }` line, so the child always sees
 * the reason naming the read verbs.
 */
export async function executeForgeRead(
  det: ForgeDetection,
  cwd: string,
  req: ForgeReadRequest,
  opts: ForgeReadExecuteOptions = {},
): Promise<string> {
  const reason = validateForgeRead(req);
  if (reason !== undefined) throw new Error(reason);
  const verb = String(req.verb);
  // The caller's bound reaches every `gh`/`glab` the read runs: `execOpts` is
  // spread into the adapter's own exec call (forge.ts), so a caller that bounds
  // a read does not get it running under the adapter's 60 s default instead —
  // and a child holding a 60 s client timeout is not left waiting on a parent
  // whose `gh` outran it.
  const forge = (opts.buildForge ?? defaultBuildForge)(det, {
    cwd,
    ...(opts.timeoutMs === undefined ? {} : { execOpts: { timeout: opts.timeoutMs } }),
  });
  const run = <T>(value: Promise<T>): Promise<string> => value.then((v) => render(v));
  /**
   * A list read. The raw bytes are the answer — the forge's own JSON, sent
   * exactly as the CLI wrote it — and the row count of those bytes decides
   * whether a cap line is appended. No second exec runs to map the rows: a
   * second read of a moving forge would be a second moment presented as one
   * answer, and it would double every list read the parent serves.
   */
  const runList = (stdout: string): string => `${stdout}${listCapNote(stdout)}`;
  switch (verb) {
    case "issue_view":
      return run(forge.issueView(Number(req.number)));
    case "issue_comments":
      return run(forge.issueComments(Number(req.number)));
    case "issue_list":
      return runList(
        await forge.issueListRaw({
          state: typeof req.state === "string" ? req.state : undefined,
        }),
      );
    case "issue_search":
      return runList(
        await forge.issueSearchRaw(String(req.query), { allStates: req.allStates === true }),
      );
    case "pr_view":
      return run(forge.prView(Number(req.number)));
    case "pr_list": {
      const listOpts = {
        state: typeof req.state === "string" ? req.state : undefined,
        sourceBranch: typeof req.sourceBranch === "string" ? req.sourceBranch : undefined,
      };
      return runList(await forge.prListRaw(listOpts));
    }
    case "pr_reviews":
      return run(forge.prReviews(Number(req.number)));
    case "pr_checks":
      return run(forge.prChecks(Number(req.number)));
    case "pr_diff":
      return capRawText(await forge.prDiff(Number(req.number)));
    case "ci_run":
      return run(forge.ciRun(Number(req.id)));
    case "ci_run_log":
      return capRawText(await forge.ciRunLog(Number(req.id)));
    case "label_list":
      return run(forge.labelList().then((r) => r.names));
    case "repo_settings":
      return run(forge.repoSettings());
    default:
      throw new Error(`forge_read: no executor for verb "${verb}"`);
  }
}

/** JSON for the structured rows, verbatim text for the diff/log reads. */
function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * `… truncated: N of M bytes` — the tail of a raw-text read the child never
 * sees, said in the bytes it does. `…` is the single U+2026 ellipsis character.
 */
const TRUNCATION_NOTE = "\n\u2026 truncated: ";

/**
 * The parent's ceiling on one raw-text read (`pr_diff`, `ci_run_log`) in bytes.
 *
 * These two verbs answer the forge's own text rather than a mapped row set, so
 * nothing between the CLI and the child's context bounds them: a diff of a
 * generated lockfile or a CI log of a failed build arrives whole and the child
 * pays for it on every later turn. 200 KB is comfortably a full diff of real
 * source and comfortably past a job trace, and the head is what a reader wants
 * first — a build's real error is early, not in the last 200 KB.
 */
export const FORGE_RAW_TEXT_CAP_BYTES = 200 * 1024;

/**
 * Keep the head of a raw-text answer and say what was dropped. A read under the
 * cap comes back byte-for-byte unchanged — a diff that silently gained a
 * truncation line would be a diff that is no longer what the forge sent.
 */
export function capRawText(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= FORGE_RAW_TEXT_CAP_BYTES) return text;
  // The bound is a byte bound, so the slice that reaches it is found by shrinking
  // WHOLE CHARACTERS, never code units: a slice cut on a code-unit boundary can
  // leave half of a surrogate pair, which is invalid text that any later UTF-8
  // encode turns into U+FFFD. `for…of` iterates code points, so the head is
  // always a prefix of complete characters and the byte total never overshoots.
  let kept = "";
  let keptBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (keptBytes + charBytes > FORGE_RAW_TEXT_CAP_BYTES) break;
    kept += char;
    keptBytes += charBytes;
  }
  return `${kept}${TRUNCATION_NOTE}${bytes - keptBytes} of ${bytes} bytes`;
}

/**
 * The line a list read that FILLED its page answers with. A list that returned
 * exactly the page size may have had more rows the CLI did not send, and the
 * child cannot tell that from a complete list by itself, so the disclosure rides
 * in the bytes it reads. A short list — or bytes that are not a JSON array —
 * answer nothing: silence is the normal case and an uninformative note on every
 * read is noise that trains the reader to ignore it.
 *
 * `trim` before counting: `gh` and `glab` both end their output with a newline,
 * and `JSON.parse` reads the rows under either. A count that did not trim would
 * call a full page short (missing the disclosure) — and a disclosure is worth
 * precisely nothing when the case it exists for is the one it misses.
 */
function listCapNote(stdout: string): string {
  const rows = listRowCount(stdout.trim());
  if (rows === undefined || rows !== FORGE_LIST_LIMIT) return "";
  return `\ncapped at ${rows} rows; the list may be incomplete`;
}
