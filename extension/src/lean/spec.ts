/**
 * lean/spec — the pi-spec v1 contract between /plan and /work-lean.
 *
 * An issue body carries ONE fenced block whose info string is exactly
 * `pi-spec v1`. Its content is JSON of shape `PiSpec`. The block is the whole
 * contract: the driver does not infer scope, criteria, or size from prose, so
 * an issue that does not carry one is not ready and says so.
 *
 * Three exports, each with one job:
 *   - `parsePiSpec`  — read the block, or name the reason it is unusable.
 *   - `readiness`    — the rules a well-formed spec can still fail.
 *   - `renderPiSpec` — write the block (`/plan` uses it); round-trips with parse.
 *
 * Every failure names itself. "No block", "two blocks", "invalid JSON" and
 * "wrong type" are four distinct reasons, because an operator fixing an issue
 * needs to know which of the four they are looking at.
 */

/** How a criterion is checked. `command` criteria additionally carry a command. */
export type VerifyKind = "test" | "command" | "manual";

/** `L` is not a valid size for one run: `readiness` fails it and says split it. */
export type SpecSize = "S" | "M" | "L";

export interface Criterion {
  id: string;
  text: string;
  verify: VerifyKind;
  command?: string;
}

export interface SpecScope {
  /** Paths this run may touch. */
  paths?: string[];
  /** Paths this run must not touch. */
  out?: string[];
}

export interface PiSpec {
  problem: string;
  criteria: Criterion[];
  scope?: SpecScope;
  size: SpecSize;
}

export type ParseResult = { ok: true; spec: PiSpec } | { ok: false; reason: string };

/** The exact info string a spec block must declare. */
export const SPEC_INFO = "pi-spec v1";

/** Criterion ids are AC1, AC2, … — positional, stable, and greppable. */
export const CRITERION_ID = /^AC\d+$/;

const VERIFY_KINDS: readonly string[] = ["test", "command", "manual"];
const SIZES: readonly string[] = ["S", "M", "L"];

/**
 * Fenced blocks in a CommonMark body: a run of ≥3 backticks or tildes opens,
 * a run of the same char at least as long closes. Blank lines and indented
 * fences do not break the run, so a spec block may contain either.
 */
function fencedBlocks(body: string): { info: string; content: string }[] {
  const lines = body.split(/\r?\n/);
  const blocks: { info: string; content: string }[] = [];
  let open: { char: string; len: number; info: string; content: string[] } | undefined;
  for (const line of lines) {
    // Group 2 is the fence run, group 3 everything after it: the info string
    // on an opening line, and nothing at all on a closing one.
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    const run = m?.[2];
    const rest = m?.[3] ?? "";
    if (open) {
      // A closing fence is the same character, at least as long, and carries
      // no info string of its own.
      if (
        run !== undefined &&
        run[0] === open.char &&
        run.length >= open.len &&
        rest.trim() === ""
      ) {
        blocks.push({ info: open.info.trim(), content: open.content.join("\n") });
        open = undefined;
        continue;
      }
      open.content.push(line);
      continue;
    }
    if (run !== undefined) {
      open = { char: run[0] as string, len: run.length, info: rest, content: [] };
    }
  }
  // An unterminated fence is not a block — a truncated body is "no block",
  // not a block whose JSON happens to be broken. `truncatedAt` records where,
  // so the reason can point an operator at the line instead of sending them
  // off to hunt for a typo that is not there.
  return blocks;
}

/**
 * The line number (1-based) of the last opening fence that never closed, or
 * undefined when every fence closed. CommonMark drops such a fence, so this
 * is deliberately separate from `fencedBlocks`: the parse result stays
 * "no block", and only the message gains the line that was truncated.
 */
function unterminatedFenceLine(body: string): number | undefined {
  const lines = body.split(/\r?\n/);
  let open: { char: string; len: number; line: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[i] as string);
    const run = m?.[2];
    if (run === undefined) continue;
    const rest = m?.[3] ?? "";
    if (open) {
      if (run[0] === open.char && run.length >= open.len && rest.trim() === "") {
        open = undefined;
        continue;
      }
      continue;
    }
    open = { char: run[0] as string, len: run.length, line: i + 1 };
  }
  return open?.line;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** The type-level checks parsePiSpec cannot delegate to JSON.parse. */
function validate(obj: unknown): string | undefined {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj))
    return "spec must be a JSON object";
  const o = obj as Record<string, unknown>;
  if (typeof o.problem !== "string" || o.problem.trim() === "")
    return "spec.problem must be a non-empty string";
  if (!Array.isArray(o.criteria)) return "spec.criteria must be an array";
  for (const [i, raw] of o.criteria.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return `spec.criteria[${i}] must be an object`;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string") return `spec.criteria[${i}].id must be a string`;
    if (typeof c.text !== "string" || c.text.trim() === "")
      return `spec.criteria[${i}].text must be a non-empty string`;
    if (typeof c.verify !== "string" || !VERIFY_KINDS.includes(c.verify))
      return `spec.criteria[${i}].verify must be one of ${VERIFY_KINDS.join(", ")}`;
    if (c.command !== undefined && typeof c.command !== "string")
      return `spec.criteria[${i}].command must be a string`;
  }
  if (o.scope !== undefined) {
    if (typeof o.scope !== "object" || o.scope === null || Array.isArray(o.scope))
      return "spec.scope must be an object";
    const s = o.scope as Record<string, unknown>;
    if (s.paths !== undefined && !isStringArray(s.paths))
      return "spec.scope.paths must be string[]";
    if (s.out !== undefined && !isStringArray(s.out)) return "spec.scope.out must be string[]";
  }
  if (typeof o.size !== "string" || !SIZES.includes(o.size))
    return 'spec.size must be one of "S", "M", "L"';
  return undefined;
}

/** The info string of the single spec block in a body, or undefined for none. */
export function readPiSpecBlockInfo(body: string): string | undefined {
  return fencedBlocks(body).find((b) => b.info === SPEC_INFO)?.info;
}

/** Read the `pi-spec v1` block out of an issue body. Never throws. */
export function parsePiSpec(body: string): ParseResult {
  const specs = fencedBlocks(body).filter((b) => b.info === SPEC_INFO);
  if (specs.length === 0) return { ok: false, reason: "no pi-spec v1 block" };
  if (specs.length > 1)
    return { ok: false, reason: `${specs.length} pi-spec v1 blocks, expected at most 1` };
  const content = (specs[0]?.content ?? "").trim();
  if (content === "") return { ok: false, reason: "pi-spec v1 block is empty" };
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch (err) {
    // A body that ends inside a fence reads here as broken JSON, and an
    // operator told "invalid JSON" will hunt for a typo that is not there.
    // Naming the line that opened the fence is the actionable version of the
    // same fact.
    if (unterminatedFenceLine(body) !== undefined)
      return {
        ok: false,
        reason: "pi-spec v1 block is not valid JSON: the fence it sits in was never closed",
      };
    return { ok: false, reason: `pi-spec v1 block is not valid JSON: ${(err as Error).message}` };
  }
  const invalid = validate(obj);
  if (invalid) return { ok: false, reason: invalid };
  return { ok: true, spec: obj as unknown as PiSpec };
}

/**
 * The rules a structurally valid spec can still fail. Empty means ready.
 *
 * Separated from `parsePiSpec` on purpose: parse answers "is this the shape
 * we can read", readiness answers "can a run actually be attempted from it".
 * The first is a fact about the bytes, the second is a judgement about the
 * work, and only the second one gets an operator-facing comment.
 */
export function readiness(spec: PiSpec): string[] {
  const failed: string[] = [];
  if (spec.criteria.length < 1) failed.push("no acceptance criteria");
  // One row per criterion id, so a duplicated id is reported once rather than
  // as two lines that read like two different problems for one fix.
  const seen = new Map<string, string[]>();
  for (const c of spec.criteria) {
    const dup = seen.has(c.id);
    // The fault is recorded per id, and every line is prefixed with the id so
    // an operator reading the issue comment knows which criterion it is about
    // — including a duplicate, which reads as "this id appears twice" rather
    // than as two unrelated problems.
    const reasons = seen.get(c.id) ?? [];
    seen.set(c.id, reasons);
    if (reasons.length > 0 || dup) reasons.push(`criterion ${c.id}: duplicate id`);
    if (!CRITERION_ID.test(c.id))
      reasons.push(`criterion ${c.id}: id does not match ${CRITERION_ID}`);
    if (!VERIFY_KINDS.includes(c.verify))
      reasons.push(`criterion ${c.id}: verify "${c.verify}" is not a valid kind`);
    if (c.verify === "command" && (c.command === undefined || c.command.trim() === ""))
      reasons.push(`criterion ${c.id}: a command criterion must carry a non-empty command`);
  }
  failed.push(...[...seen.values()].flat());
  if (spec.size === "L") failed.push("size L is too large for one run — split it");
  return failed;
}

/** Render the fenced block. `parsePiSpec(renderPiSpec(s))` returns `s` unchanged. */
export function renderPiSpec(spec: PiSpec): string {
  return `\`\`\`${SPEC_INFO}\n${JSON.stringify(spec, null, 2)}\n\`\`\``;
}
