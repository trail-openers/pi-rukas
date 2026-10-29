/**
 * headless/supervise — a `work` run's result survives a runner that dies
 * (#1591).
 *
 * The runner writes its stdout result once, at the end. A runner that dies
 * natively — Bun aborts when it cannot create a thread, which a container at
 * its `pids.max` produces — writes nothing, so the host got an empty `--json`
 * result for a cycle that had already opened its PR. No JavaScript handler
 * runs on such an abort, so the only place that can still answer is another
 * process.
 *
 * `cli.ts` therefore runs `work` as a child of itself (marked by
 * SUPERVISED_ENV) and holds its stdout. When the child exits with a result,
 * that result is passed through unchanged with the child's exit code. When it
 * exits without one, the supervisor projects each issue from its state file —
 * which the driver persists at every step boundary and before every dispatch —
 * and reports `error.code: "crash"` with exit 30. stderr (the NDJSON progress
 * stream) is inherited and never touched.
 *
 * #1863 — "with a result" is decided by the BYTES, not by the exit code. The
 * inner runner has its own backstop (`ensure-result.ts`) that prints a
 * `driver-wedged` document — whose own `exitCode` is 30 — and exits 30 when its
 * driver never answered. The first shape of this file only asked whether stdout
 * was non-empty, which the wedge document satisfies; but the passthrough returned
 * the CHILD's exit code, and a runner that had printed its document and then
 * been torn down before the code reached the parent got the supervisor's own
 * `crash`/30 written on top of it. So the passthrough is now keyed on the stdout
 * carrying a COMPLETE, PARSEABLE result document (`parseResultDocument`) and
 * returns THAT document's `exitCode` — the child's exit code is the fallback,
 * not the authority. The `crash` projection remains exactly what a child that
 * printed nothing, or printed only garbage, gets — crash classification is
 * otherwise unchanged.
 *
 * A child that DIED is a different thing from a child that answered, so the
 * bytes only count when the child exited normally — no `exit.signal` and no
 * `exit.error`. A child that printed a healthy-looking document and then caught
 * SIGKILL is a crash whatever it printed: a killed process cannot vouch for the
 * document it wrote, and a host reading exit 0 / `merged` out of a killed runner
 * is the exact lie #1591 was filed to remove. A signal-killed or spawn-errored
 * child therefore keeps the `crash`/30 projection and its signal message, which
 * is what `headless.md` and `troubleshooting.md` promise. The wedge path still
 * passes through, because `withResultGuarantee` prints its document and then
 * RETURNS an exit code — that child exits normally.
 *
 * Only ONE JSON document ever reaches the host, and it is the child's. In
 * `--json` mode the child prints that line and nothing else, so the forwarder
 * emits the document line alone and stray bytes printed before it stay out.
 * In text mode the child ALSO prints the human summary (`pi-rukas-headless: #N
 * status (exit N)`) and an optional `error:` line ahead of it (#1866), and those
 * lines are the documented text-mode output — a forwarder that kept only the
 * document turned every text-mode host into a JSON host. So text mode forwards
 * those two documented line shapes first, in the child's own order, and the
 * document line after them. Everything else is dropped: a line is prose only if
 * it carries the published prefix, never merely because it is not the document
 * (see `proseLinesBefore`), so bytes a child vomited before OR after its result
 * stay off the host's stream.
 *
 * The line the supervisor echoes is the LINE IT FOUND, byte for byte, and the
 * index comes from the same backward scan that parsed it (`parseResultLine`).
 * Re-locating the document by comparing each line against `JSON.stringify` of
 * the parsed object would match nothing whenever the child's bytes are valid
 * JSON with different whitespace or key order, and a head that never cuts is a
 * head that forwards the whole buffer — the second document on the host's
 * stream, which is the one property this file exists to keep.
 *
 * SIGTERM / SIGINT / SIGHUP are forwarded to the child, so the interrupt
 * contract (run.ts) is unchanged. Setting `PI_ENSEMBLE_HEADLESS_SUPERVISED=1`
 * runs `work` in-process, without a supervisor.
 */

import { spawn } from "node:child_process";
import { resourceReport } from "../resource-budget.ts";
import { isTerminalState, readState, workStateFile } from "../workflow-state.ts";
import { readBuildCommit, readBuildVersion } from "./build.ts";
import { EXIT, exitCodeForState } from "./exit-code.ts";
import {
  ERROR_PREFIX,
  type IssueResult,
  RESULT_SCHEMA_VERSION,
  type ResultDocument,
  SUMMARY_PREFIX,
  notStartedResult,
  projectIssue,
  resultDocument,
} from "./result.ts";
import { workPathStdout } from "./work-path-stdout.ts";

export const SUPERVISED_ENV = "PI_ENSEMBLE_HEADLESS_SUPERVISED";

const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * The only two prose line shapes a text-mode child is allowed onto the host's
 * stdout. `formatResultDocument` emits exactly these (`SUMMARY_PREFIX` first,
 * then the optional `ERROR_PREFIX` line, then the document), so anything else
 * the child printed is its own business. Re-exported so the offline test builds
 * a conforming fixture rather than guessing at the prefixes; the constants are
 * declared in `result.ts` so the producer in `ensure-result.ts` and this
 * consumer cannot drift apart.
 */
export { ERROR_PREFIX, SUMMARY_PREFIX } from "./result.ts";

export interface SuperviseOptions {
  repoRoot: string;
  issues: number[];
  json: boolean;
  /** The child's argv: `[command, ...args]`. Defaults to re-running this CLI. */
  command: string[];
  write?: (s: string) => void;
}

/**
 * The last complete result document on a child's stdout, and what the supervisor
 * needs from it, or undefined.
 *
 * "Complete" is load-bearing: a runner killed mid-write leaves a truncated line
 * that is neither nothing nor a document, and calling that a result would pass
 * a half-written one to the host. So only a line that parses as a result
 * document — the schema version this build writes, an `issues` array and an
 * `exitCode` that is one of the PUBLISHED codes — counts, and the LAST such
 * line wins (a runner that printed a document and then a stray line still gets
 * its document). The code is validated, not trusted: it is what the supervisor
 * returns to the host, so `Infinity`, a float, a negative or a number the
 * contract never published is not a result but garbage, and garbage is what the
 * `crash` projection is for.
 *
 * The return type says exactly what was verified: `exitCode` was checked against
 * the published set, `doc` is the parsed line, and `index` is the stdout line it
 * came from — which is the only place the caller can find the bytes it must
 * echo, since a re-parse of the document is not byte-identical to what the child
 * wrote (`JSON.stringify` normalises whitespace and keeps key order, so a child
 * whose line carries extra spaces or reordered keys has no line equal to the
 * stringify of its own parse). Everything else in the parsed line — per-issue
 * results, `error`, `resources` — is carried through unchecked, so `doc` is
 * typed `ResultDocument` (the caller re-emits the object it read, not a
 * projection of it) rather than narrowed to fields this function never inspected.
 */
export function parseResultLine(out: string): { doc: ResultDocument; index: number } | undefined {
  const lines = out.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || !line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const doc = parsed as Partial<ResultDocument>;
    if (
      doc.schemaVersion === RESULT_SCHEMA_VERSION &&
      Array.isArray(doc.issues) &&
      isPublishedExitCode(doc.exitCode)
    ) {
      return { doc: parsed as ResultDocument, index: i };
    }
  }
  return undefined;
}

/**
 * The last complete result document on a child's stdout, or undefined.
 *
 * The locator form of `parseResultLine` for callers that only need the document
 * (the published-code acceptance loop in the offline test). A caller that will
 * echo bytes wants `parseResultLine` instead — the index is what makes the
 * forwarded line the child's own.
 */
export function parseResultDocument(out: string): ResultDocument | undefined {
  return parseResultLine(out)?.doc;
}

/**
 * Is `code` one of the exit codes the CLI publishes? The document's `exitCode`
 * becomes the supervisor's own return value, so an out-of-contract number must
 * not reach the host: only a non-negative safe integer from `EXIT` qualifies.
 */
function isPublishedExitCode(code: unknown): code is number {
  if (typeof code !== "number" || !Number.isSafeInteger(code)) return false;
  return Object.values(EXIT).includes(code as (typeof EXIT)[keyof typeof EXIT]);
}

/**
 * The document line a child wrote, byte for byte, or `undefined` when `index`
 * names no line at all (a caller that hand-built an index — never the case on
 * the live path, always the safe answer for one).
 */
function documentLineAt(lines: string[], index: number): string | undefined {
  const line = lines[index];
  return line === undefined ? undefined : line.trim();
}

/**
 * The child's prose ahead of its result document, in the child's own order:
 * only the lines a text-mode host is PROMISED — the `pi-rukas-headless: ` summary
 * and the `error:` reason `formatResultDocument` emits before the machine line.
 * The whitelist is the point: "not the document" is not a property that makes a
 * line prose, so any line the child printed for its own reasons (a library's
 * warning, a stray `console.log`, a second half-written document) is dropped
 * rather than copied onto the host's stream. The head is cut at the index the
 * parser reported, so nothing after the document is ever considered — the
 * stray-bytes rule the document-only forwarder exists for.
 *
 * `lines`/`index` come from `parseResultLine`, so the cut and the parse cannot
 * disagree about where the document is. Returns `""` for a stream with no
 * whitelisted prose (the `--json` shape), so the caller's output is byte-identical
 * to the document-only forward in that case.
 */
export function proseLinesBefore(lines: string[], index: number): string {
  const head = lines.slice(0, index < 0 ? 0 : index);
  const prose = head.filter(
    (l) => l.startsWith(`${SUMMARY_PREFIX} `) || l.startsWith(`${ERROR_PREFIX} `),
  );
  return prose.length === 0 ? "" : `${prose.join("\n")}\n`;
}

/** Each issue as its state file shows it; a non-terminal state exits 30. */
async function projectFromState(repoRoot: string, issues: number[]): Promise<IssueResult[]> {
  const out: IssueResult[] = [];
  for (const issue of issues) {
    const file = workStateFile(repoRoot, issue);
    const state = await readState(repoRoot, issue).catch(() => undefined);
    if (!state) {
      out.push(notStartedResult(issue, file, EXIT.crash));
      continue;
    }
    const code = isTerminalState(state) ? exitCodeForState(state) : EXIT.crash;
    out.push({ ...projectIssue(state, file), exitCode: code });
  }
  return out;
}

/** Run `work` in a child and return the exit code to use. */
export async function superviseWork(opts: SuperviseOptions): Promise<number> {
  // The ONE stdout writer on the `work` path (#1863 round 1): the default is the
  // latch, so the supervisor's forwarded child document and its own crash
  // projection are mutually exclusive by construction, and nothing else on this
  // path can put a second document on the host's stream. Both arms below call
  // `write`, never `process.stdout`, so a caller that injects a sink (every
  // offline test) sees the same single-document property the host gets.
  const write = opts.write ?? ((s: string) => workPathStdout(s));
  const [cmd, ...args] = opts.command as [string, ...string[]];
  const child = spawn(cmd, args, {
    env: { ...process.env, [SUPERVISED_ENV]: "1" },
    stdio: ["inherit", "pipe", "inherit"],
  });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const handlers = FORWARDED.map((sig) => [sig, forward(sig)] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  const exit = await new Promise<{ code: number | null; signal: string | null; error?: Error }>(
    (resolve) => {
      child.on("error", (error) => resolve({ code: null, signal: null, error }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );
  for (const [sig, h] of handlers) process.off(sig, h);
  const out = Buffer.concat(chunks).toString("utf8");
  // A child that never wrote a byte is indistinguishable from one whose bytes
  // were lost: `close` fires when the stdio STREAMS end, not when the process
  // is reaped, so a child that was still running when its pipes closed is
  // already past the point where anything it prints could be recovered. The
  // decision therefore reads the bytes (parseResultDocument) and nothing else —
  // and #1863's wedge document reaches this function exactly like the runner's
  // own result does, because ensure-result.ts writes it to the same stdout.
  // A child that died by a signal, or never started, has no say: its bytes are
  // not a result. Everything else with a complete document on stdout is.
  const answered = exit.signal || exit.error ? undefined : parseResultLine(out);
  if (answered !== undefined) {
    // The document LINE, not the buffer: stray bytes ahead of it are not part
    // of the host's contract. NOTE `write` — the injectable sink the caller may
    // have supplied. Routing this through the process-wide latch instead made it
    // contend with the crash projection below (the supervisor has exactly one
    // document, whichever arm produced it), and in a process whose latch had
    // already been armed it silently DROPPED the child's document: the host read
    // nothing while the process exited with the code of a document nobody saw.
    // The bytes are the child's own line at the parsed index — never the
    // re-stringify of the parse, which is what made a whitespace-different but
    // valid document unlocatable and forwarded the whole buffer as "prose".
    const lines = out.split("\n");
    const document = documentLineAt(lines, answered.index) ?? JSON.stringify(answered.doc);
    // Text mode: the child's whitelisted human lines go out before its document,
    // because they are the output the text-mode host was promised. JSON mode
    // prints no prose, so `proseLinesBefore` returns "" and this is the document
    // alone.
    write(opts.json ? `${document}\n` : `${proseLinesBefore(lines, answered.index)}${document}\n`);
    return answered.doc.exitCode;
  }
  const how = exit.error
    ? `could not start: ${exit.error.message}`
    : exit.signal
      ? `died with ${exit.signal}`
      : `exited ${exit.code} without a result`;
  const message = `the runner process ${how}; each issue is projected from its state file`;
  const results = await projectFromState(opts.repoRoot, opts.issues);
  if (opts.json) {
    const doc = resultDocument(
      { exitCode: EXIT.crash, results, error: { code: "crash", message } },
      { commit: readBuildCommit(), version: readBuildVersion() },
    );
    write(`${JSON.stringify({ ...doc, resources: resourceReport() })}\n`);
  } else {
    const parts = results.map((r) => `#${r.issue} ${r.status} (exit ${r.exitCode})`);
    write(`pi-rukas-headless: ${parts.join(", ")}\nerror: crash — ${message}\n`);
  }
  return EXIT.crash;
}
