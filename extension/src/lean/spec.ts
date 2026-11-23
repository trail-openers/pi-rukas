/**
 * lean/spec — the pi-spec v1 contract between /plan and /work-lean.
 *
 * An issue body carries ONE fenced block whose info string is exactly `pi-spec v1`, holding JSON of shape
 * `PiSpec`. The block is the whole contract: the driver infers no scope, criteria, or size from prose, so an
 * issue without one is not ready and says so.
 *
 * Every failure names itself — "no block", "two blocks", "invalid JSON" and "wrong type" are four distinct
 * reasons.
 */

/** How a criterion is checked. `command` criteria additionally carry a command. */
type VerifyKind = "test" | "command" | "manual";

/** `L` is not a valid size for one run: `readiness` fails it and says split it. */
type SpecSize = "S" | "M" | "L";

export interface Criterion {
  id: string;
  text: string;
  verify: VerifyKind;
  command?: string;
}

interface SpecScope {
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

/** The parse reason for a body with no block: `derive` stands in for it, a host falls back on it. */
export const NO_BLOCK_RULE = "no pi-spec v1 block";

/** Criterion ids are AC1, AC2, … — positional, stable, and greppable. */
export const CRITERION_ID = /^AC\d+$/;

const VERIFY_KINDS: readonly string[] = ["test", "command", "manual"];
const SIZES: readonly string[] = ["S", "M", "L"];

/** A fence line: up to 3 spaces of indent, the run, and everything after it. */
const FENCE_LINE = /^(?: {0,3})(?<run>`{3,}|~{3,})(?<rest>.*)$/;

/**
 * Whether the whole LINE `line` closes a sample opened by `char`/`len`: up to 3 leading spaces, a run of the
 * same character at least as long as the opener's, and NOTHING but whitespace after the run.
 *
 * The one closing rule every reader of a drafted or filed body shares — `fencedBlocks`, `stripPiSpecBlocks` and
 * the `/plan` section walker all decide boundaries with it, and where they disagree the same body reads two
 * ways. The whole-line shape is the predicate: two spellings of the "nothing but the run" condition are not
 * equivalent, because JS treats U+2028 and U+2029 as line terminators. The tail test here is a trimmed
 * comparison for exactly that reason.
 */
export function closesFenceLine(line: string, char: string, len: number): boolean {
  const g = FENCE_LINE.exec(line)?.groups;
  const run = g?.run as string | undefined;
  return run !== undefined && run[0] === char && run.length >= len && (g?.rest ?? "").trim() === "";
}

/**
 * Collapse text to the shape a comparison against another rendering of the same words can survive: whitespace
 * runs are one space, leading and trailing whitespace goes. The `/plan` problem line restates the body, so the
 * two differ only in layout.
 */
export function normalizeProse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Fenced blocks in a CommonMark body: a run of ≥3 backticks or tildes opens, a run of the same char at least as
 * long closes. Blank lines and indented fences do not break the run. Closes with {@link closesFenceLine}, the
 * rule the other readers share. Exported for `lean/spec-derive.ts`, which reads a block
 * out of a child's PROSE reply: `parsePiSpec` reads a body whose whole content is the
 * contract, so a reply that says a word before its fence needs the block located first.
 */
export function fencedBlocks(body: string): { info: string; content: string }[] {
  const lines = body.split(/\r?\n/);
  const blocks: { info: string; content: string }[] = [];
  let open: { char: string; len: number; info: string; content: string[] } | undefined;
  for (const line of lines) {
    // Group 2 is the fence run, group 3 everything after it.
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    const run = m?.[2];
    const rest = m?.[3] ?? "";
    if (open) {
      // A closing fence is the same character, at least as long, and carries no info string — all three decided
      // by the shared predicate.
      if (closesFenceLine(line, open.char, open.len)) {
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
  // An unterminated fence is not a block — a truncated body is "no block", not a block whose JSON happens to
  // be broken.
  return blocks;
}

/**
 * The line number (1-based) of the last opening fence that never closed, or
 * undefined when every fence closed. Separate from `fencedBlocks` so the parse
 * result stays "no block" and only the message gains the truncated line.
 *
 * Exported for `lean/spec-for.ts`: a body cut off inside a `pi-spec v1` fence reads
 * as "no block", and the one accessor that stands in for that reason must be able to
 * tell it from a body that never carried a contract.
 */
export function unterminatedFenceLine(body: string): number | undefined {
  const lines = body.split(/\r?\n/);
  let open: { char: string; len: number; line: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    const run = m?.[2];
    if (run === undefined) continue;
    if (open) {
      if (closesFenceLine(line, open.char, open.len)) {
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

/**
 * The body with its TERMINATED `pi-spec v1` fence removed, for a child shown the issue as its task statement
 * that must not be handed the contract twice.
 *
 * Only a fence whose info string trims to `SPEC_INFO` is dropped; everything else survives byte-for-byte,
 * including the shapes that LOOK like a spec — a prefixed info string, a tilde fence, an indented fence, and an
 * unterminated `pi-spec v1` block.
 *
 * What goes is the opening line, the content and the closer, plus AT MOST ONE flanking blank. Bounded to one,
 * and only when a blank survived on each side, so bodies with nothing to strip come back byte-identical.
 */
export function stripPiSpecBlocks(body: string): string {
  const lines = body.split(/\r?\n/);
  // Three named groups, not indices: in `(\`{3,}|~{3,})` an alternative that does not participate captures "".
  const FENCE = /^(?<indent> {0,3})(?<run>`{3,}|~{3,})(?<rest>.*)$/;
  const kept: string[] = [];
  let open: { char: string; len: number; spec: boolean; buf: string[] } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const g = FENCE.exec(line)?.groups;
    const run = g?.run;
    const rest = g?.rest ?? "";
    if (open) {
      if (closesFenceLine(line, open.char, open.len)) {
        // A spec block: nothing of `buf` is emitted. Any other fence goes back WHOLE.
        if (!open.spec) kept.push(...open.buf, line);
        // …and a spec block takes ONE of its flanking blanks with it, and only when a blank still sits on both
        // sides of the removal — see the jsdoc.
        else if (kept.at(-1) === "" && lines[i + 1]?.trim() === "") kept.pop();
        open = undefined;
        continue;
      }
      open.buf.push(line);
      continue;
    }
    if (run !== undefined) {
      // The opening line is NOT yet committed: it is only text if the fence turns out not to be the block.
      open = {
        char: run[0] as string,
        len: run.length,
        spec: rest.trim() === SPEC_INFO,
        buf: [line],
      };
      continue;
    }
    kept.push(line);
  }
  // An open fence that never closed is not a block, so its lines all stay in the rendered text. Read through a
  // local: outside the loop the compiler has already narrowed the mutable `open` to `undefined`.
  const dangling = open;
  if (dangling !== undefined) kept.push(...dangling.buf);
  return kept.join("\n");
}

/**
 * Whether a fence OPENS the contract: info string equal to {@link SPEC_INFO}, or that exact info followed by a
 * space.
 *
 * A prefix test is not this predicate: `/plan` renames every drafted opener to `pi-spec v1-example` so a body
 * that QUOTES the block format is never read as a contract. `pi-spec v1` plus a space is the shape that
 * genuinely carries a second contract.
 */
function opensSpecFence(info: string): boolean {
  return info === SPEC_INFO || info.startsWith(`${SPEC_INFO}${String.fromCharCode(32)}`);
}

/**
 * A line that OPENS a fence: the run, its character, and its info string. Narrower than
 * {@link closesFenceLine}: an opener CARRIES an info string while a closer may carry nothing but whitespace.
 */
function openingFence(line: string): { char: string; len: number; info: string } | undefined {
  const g = FENCE_LINE.exec(line)?.groups;
  const run = g?.run;
  if (run === undefined) return undefined;
  return { char: run[0] as string, len: run.length, info: g?.rest ?? "" };
}

/**
 * Whether a spec-shaped fence SURVIVED in this body: an OPENING fence line at depth 0 whose info string is
 * {@link SPEC_INFO} as a whole word — the shape a second spec block would take.
 *
 * `stripPiSpecBlocks` recognises exactly `pi-spec v1`, so a fence whose info is the spec info followed by a
 * space is neither stripped nor read as a spec, and a seat shown the stripped body would be handed a second
 * copy of a contract nothing enforces. Only an OPENING FENCE LINE counts.
 *
 * Walks the body the way `stripPiSpecBlocks` does, on the same predicate: a stateless line test cannot tell an
 * opener from a line that merely LOOKS like one.
 */
export function hasSurvivingSpecShapedFence(body: string): boolean {
  let open: { char: string; len: number } | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (open !== undefined) {
      if (closesFenceLine(line, open.char, open.len)) open = undefined;
      continue;
    }
    const fence = openingFence(line);
    if (fence === undefined) continue;
    if (opensSpecFence(fence.info)) return true;
    open = fence;
  }
  return false;
}

/** Read the `pi-spec v1` block out of an issue body. Never throws. */
export function parsePiSpec(body: string): ParseResult {
  const specs = fencedBlocks(body).filter((b) => b.info === SPEC_INFO);
  if (specs.length === 0) return { ok: false, reason: NO_BLOCK_RULE };
  if (specs.length > 1)
    return { ok: false, reason: `${specs.length} pi-spec v1 blocks, expected at most 1` };
  const content = (specs[0]?.content ?? "").trim();
  if (content === "") return { ok: false, reason: "pi-spec v1 block is empty" };
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch (err) {
    // A body that ends inside a fence reads here as broken JSON, and an operator told "invalid JSON" will hunt
    // for a typo that is not there. Naming the line that opened the fence is the actionable version.
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
 * The rules a structurally valid spec can still fail. Empty means ready. Separate from `parsePiSpec`: parse
 * answers "is this the shape we can read", readiness answers "can a run be attempted from it".
 */
export function readiness(spec: PiSpec): string[] {
  const failed: string[] = [];
  if (spec.criteria.length < 1) failed.push("no acceptance criteria");
  // One row per criterion id, so a duplicated id is reported once rather than as two lines that read like two
  // different problems for one fix.
  const seen = new Map<string, string[]>();
  for (const c of spec.criteria) {
    const dup = seen.has(c.id);
    // The fault is recorded per id, and every line is prefixed with the id so an operator reading the issue
    // comment knows which criterion it is about.
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
