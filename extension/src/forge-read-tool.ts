/**
 * forge-read-tool — the read-only forge surface `forge_read` exposes (#2160).
 *
 * The tool runs in the PARENT process (`forge-read-broker.ts` serves it; the
 * child's half is `child-forge-read-activation.ts`), so every read is
 * authenticated with the parent's own login and never hits the unauthenticated
 * 60/hour limit. There is deliberately no write verb: the helper roles' forge
 * reads used to be `gh`/`glab` under the operator's credential, and a tool
 * that could also write would put the landing back in the child's hands.
 *
 * Raw bytes are returned. The public-hygiene check stays on WRITES only — a
 * read publishes nothing, and rewriting a host path out of a fetched issue
 * body would corrupt the very bytes the caller is reviewing.
 *
 * `FORGE_READ_VERBS` is the single list the tool's schema, the parent's
 * executor, and the tests all read. A verb name outside it is refused with a
 * message naming the read verbs, so a child that asks for `pr_merge` learns
 * what the tool does instead of guessing again.
 */

/** The read verbs, one per `Forge` operation. Adding one means adding a row to `executeForgeRead`. */
export const FORGE_READ_VERBS = [
  "issue_view",
  "issue_comments",
  "issue_list",
  "issue_search",
  "pr_view",
  "pr_list",
  "pr_reviews",
  "pr_checks",
  "pr_diff",
  "ci_run",
  "ci_run_log",
  "label_list",
  "repo_settings",
] as const;

export type ForgeReadVerb = (typeof FORGE_READ_VERBS)[number];

/** Every verb that writes — refused, and named so the refusal is checkable. */
export const FORGE_WRITE_WORDS = [
  "create",
  "comment",
  "edit",
  "merge",
  "close",
  "reopen",
  "ready",
  "draft",
  "add",
  "remove",
  "delete",
  "update",
  "post",
  "approve",
  "label_create",
  "label_add",
  "label_remove",
] as const;

/** The verbs a well-formed request may carry, minus the numeric-argument rule. */
const VERB_SET: ReadonlySet<string> = new Set<string>(FORGE_READ_VERBS);

/**
 * The `state` values the builders accept: `open`/`closed` for issues, `merged`
 * for PRs, `all` for both (`gh … --state all`, `glab issue list --all`).
 * Lower-case only — that is the CLI's spelling, and an uppercase `OPEN` is a
 * row's normalized state, not a filter.
 */
const FORGE_STATES: ReadonlySet<string> = new Set(["open", "closed", "merged", "all"]);

/**
 * A plain branch name: nothing the shell could read as an operator, and no
 * leading `-` that `gh`/`glab` would parse as a flag (`--upload-pack=x` is a
 * real git flag). `shq` quoting is the last line here, not the first.
 */
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

/** The request as it crosses the socket. `number`/`id` are the target's id. */
export interface ForgeReadRequest {
  type: "forge-read-request";
  verb: string;
  number?: number;
  id?: number;
  query?: string;
  state?: string;
  sourceBranch?: string;
  allStates?: boolean;
}

/** One JSON-line answer. `output` is the raw bytes the forge returned. */
export interface ForgeReadResponse {
  type: "forge-read-response";
  ok: boolean;
  output?: string;
  reason?: string;
}

/** Why a request was refused, in one line. */
function refusal(reason: string): ForgeReadResponse {
  return { type: "forge-read-response", ok: false, reason };
}

/**
 * Is this request well-formed for a read verb? Returns the refusal reason, or
 * `undefined` when the request may run. Kept separate from execution so the
 * refusal table is testable without a forge.
 */
export function validateForgeRead(req: ForgeReadRequest): string | undefined {
  const verb = req.verb;
  if (typeof verb !== "string" || verb === "") return "forge_read: no verb given";
  if (VERB_SET.has(verb)) {
    const needsNumber =
      verb === "issue_view" ||
      verb === "issue_comments" ||
      verb === "pr_view" ||
      verb === "pr_reviews" ||
      verb === "pr_checks" ||
      verb === "pr_diff";
    const needsId = verb === "ci_run" || verb === "ci_run_log";
    if (needsNumber && !isPositiveInt(req.number)) {
      return `forge_read ${verb}: needs a positive integer "number"`;
    }
    if (needsId && !isPositiveInt(req.id)) {
      return `forge_read ${verb}: needs a positive integer "id"`;
    }
    if (verb === "issue_search" && (typeof req.query !== "string" || req.query === "")) {
      return 'forge_read issue_search: needs a non-empty "query"';
    }
    // `state` and `sourceBranch` are child-supplied and land in the parent's
    // credentialed command string, so they get the same boundary check the
    // numeric targets get — anything else is refused by name, never forwarded.
    if (req.state !== undefined && !FORGE_STATES.has(req.state)) {
      return `forge_read ${verb}: "state" must be one of ${[...FORGE_STATES].join(" | ")}`;
    }
    if (req.sourceBranch !== undefined && !isBranchName(req.sourceBranch)) {
      return 'forge_read pr_list: "sourceBranch" must be a plain branch name';
    }
    return undefined;
  }
  return refusalReasonFor(verb);
}

/** The refusal a non-read verb gets: a write verb says so; anything else names the reads. */
function refusalReasonFor(verb: string): string {
  const looksLikeWrite = FORGE_WRITE_WORDS.some((w) => verb.includes(w));
  const reads = FORGE_READ_VERBS.join(", ");
  if (looksLikeWrite) {
    return `forge_read: "${verb}" is a write — the tool has no write verb (reads: ${reads})`;
  }
  return `forge_read: unknown verb "${verb}" (reads: ${reads})`;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isBranchName(v: string): boolean {
  return BRANCH_NAME.test(v) && !v.startsWith("-");
}

/**
 * The wire form of a request: every field optional, nothing trusted.
 *
 * `JSON.parse` produces exactly this and nothing type-checks it, so this is the
 * type the broker is allowed to hold before it has read the line.
 */
export type ForgeReadWire = { [K in keyof ForgeReadRequest]?: unknown };

/**
 * The trust boundary of the socket, in one function: a parsed JSON line becomes
 * a `ForgeReadRequest`, or `undefined`.
 *
 * The answer is built FIELD BY FIELD rather than by forwarding the parsed
 * object. The parsed object carries arbitrary keys from the child's payload,
 * and everything downstream reads its options off the same object — a key that
 * names a function is a key that gets called. Whitelisting here means the
 * request that reaches the executor contains the fields the tool's own schema
 * declares and nothing else, whatever rode the wire.
 *
 * A self-reported `role` is deliberately not carried through: nothing on the
 * read path branches on who the child says it is (the parent authorises), so an
 * identity asserted by the caller has no business reaching the code that builds
 * the parent's forge.
 */
export function parseForgeReadRequest(line: string): ForgeReadRequest | undefined {
  let raw: ForgeReadWire;
  try {
    raw = JSON.parse(line) as ForgeReadWire;
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") return undefined;
  if (raw.type !== "forge-read-request" || typeof raw.verb !== "string") return undefined;
  const req: ForgeReadRequest = { type: "forge-read-request", verb: raw.verb };
  if (typeof raw.number === "number") req.number = raw.number;
  if (typeof raw.id === "number") req.id = raw.id;
  if (typeof raw.query === "string") req.query = raw.query;
  if (typeof raw.state === "string") req.state = raw.state;
  if (typeof raw.sourceBranch === "string") req.sourceBranch = raw.sourceBranch;
  if (typeof raw.allStates === "boolean") req.allStates = raw.allStates;
  return req;
}

export { refusal as forgeReadRefusal };
