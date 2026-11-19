import type { IssueSpec } from "./issue-spec.ts";
/**
 * issue-spec-block — the `tehas:spec v1` block a PR body carries for an
 * approved spec, and everything pure around it: the spec's requirement ids,
 * the check child's reply read into one line per id, and the block check.
 *
 *   <!-- tehas:spec v1 -->
 *   Spec: <link> sha256:<64 hex>
 *   - <id> met: <where>
 *   - <id> not met: <why>
 *   <!-- /tehas:spec -->
 *
 * A host parks a PR whose block it cannot read, so `specBlockProblem` reads a
 * body the way the host does (lines outside fences only, exactly one block, a
 * `Spec:` line, at least one requirement line, each id once, no `:` or
 * backtick in an id, non-empty text) and the PR body is checked with it before
 * it is sent. Every line this module renders is either a validated verdict or
 * "not met": a requirement is never reported met without a file at HEAD named
 * as the evidence. Whether it is truly met is for the person who reviews.
 */
import { closesFenceLine } from "./lean/spec.ts";
import { oneLine } from "./lean/text-fence.ts";

export interface Requirement {
  id: string;
  /** The spec text that states the requirement, for the check child's prompt. */
  section: string;
}

export const SPEC_OPEN = "<!-- tehas:spec v1 -->";
export const SPEC_CLOSE = "<!-- /tehas:spec -->";
const SECTION_MAX = 4096;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
type Fence = { char: string; len: number };
const fenceOf = (run: string): Fence => ({ char: run[0] as string, len: run.length });

/** The lines of `text` that sit outside every ``` / ~~~ fence, fence lines excluded. */
function outsideFences(text: string): string[] {
  const out: string[] = [];
  let open: Fence | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (open) {
      if (closesFenceLine(line, open.char, open.len)) open = undefined;
      continue;
    }
    const run = FENCE_OPEN.exec(line)?.[1];
    if (run !== undefined) open = fenceOf(run);
    else out.push(line);
  }
  return out;
}

/**
 * `body` ready for one block to be appended: each closed block outside a fence
 * is removed, a stray open or close line is dropped alone (the lines after an
 * unclosed open are kept), and a fence still open at the end is closed, so the
 * appended block is the only one a host reads and never sits inside a fence.
 */
export function withoutSpecBlocks(body: string): string {
  const kept: string[] = [];
  let fence: Fence | undefined;
  let inBlock: string[] | undefined;
  for (const line of body.split("\n")) {
    const into = inBlock ?? kept;
    const t = line.trim();
    if (fence) {
      into.push(line);
      if (closesFenceLine(line, fence.char, fence.len)) fence = undefined;
    } else if (t === SPEC_OPEN) {
      kept.push(...(inBlock ?? []));
      inBlock = [];
    } else if (t === SPEC_CLOSE) inBlock = undefined;
    else {
      const run = FENCE_OPEN.exec(line)?.[1];
      if (run !== undefined) fence = fenceOf(run);
      into.push(line);
    }
  }
  kept.push(...(inBlock ?? []));
  if (fence) kept.push(fence.char.repeat(fence.len));
  return kept.join("\n");
}

// An id at line start, after an optional list marker, heading, table pipe, emphasis or bracket:
// R1, FR-3, NFR-12, REQ-001, R1.2 — followed by a delimiter, never by more of a word.
const ID_LINE =
  /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:#{1,6}\s+)?(?:\|\s*)?(?:\*\*|__|\[)?([A-Z][A-Z0-9]{0,9}-?\d+(?:\.\d+)*)(?::|\.(?=\s|$)|\)|\]|\s*\||\*\*|__| - | — )/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;

/** Heading or name text as an id: no `#` at either end, no `:`, backtick or `*`, one short line. */
const cleanId = (s: string): string => oneLine(s.replace(/^#+|#+$/g, "").replace(/[:`*]/g, ""), 80);

/**
 * Walk `lines`, opening a requirement wherever `idOf` names one. "" from `idOf`
 * closes the open one; so does a line `ends` accepts. The first occurrence of
 * an id wins and a repeat contributes nothing, so each id is listed once.
 */
function collect(
  lines: string[],
  idOf: (line: string) => string | undefined,
  ends: (line: string) => boolean,
): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  let cur: Requirement | undefined;
  for (const line of lines) {
    const id = idOf(line);
    if (id !== undefined && id !== "" && !seen.has(id)) {
      seen.add(id);
      cur = { id, section: line };
      out.push(cur);
    } else if (id !== undefined || ends(line)) cur = undefined;
    else if (cur && cur.section.length < SECTION_MAX)
      cur.section = `${cur.section}\n${line}`.slice(0, SECTION_MAX);
  }
  return out;
}

/**
 * The spec's requirements: its own ids when it has any; else one per heading
 * at the shallowest level present; else one named after the spec, so a block
 * always has a requirement line.
 */
export function extractRequirements(text: string, fallbackName: string): Requirement[] {
  const lines = outsideFences(text);
  const byId = collect(
    lines,
    (l) => ID_LINE.exec(l)?.[1],
    (l) => HEADING.test(l),
  );
  if (byId.length > 0) return byId;
  const levels = lines.flatMap((l) => {
    const m = HEADING.exec(l);
    return m ? [(m[1] as string).length] : [];
  });
  if (levels.length > 0) {
    const top = Math.min(...levels);
    const byHeading = collect(
      lines,
      (l) => {
        const m = HEADING.exec(l);
        return m && (m[1] as string).length === top ? cleanId(m[2] ?? "") : undefined;
      },
      () => false,
    );
    if (byHeading.length > 0) return byHeading;
  }
  return [{ id: cleanId(fallbackName) || "spec", section: text.slice(0, SECTION_MAX) }];
}

/** Paths a verdict's text names, with `:line` and trailing punctuation dropped. */
const namedPaths = (text: string): string[] =>
  text.split(/[\s,;()`'"<>]+/).map((t) => t.replace(/[:#].*$/, "").replace(/\.+$/, ""));

/**
 * One block line per id, in the order given. A reply line counts only for a
 * known id and only the first one per id; a `met` that names no file present
 * at `head` is reported not met, and an id with no line is reported not met.
 */
export function parseCheckReply(
  reply: string,
  ids: string[],
  headFiles: ReadonlySet<string>,
  head: string,
): string[] {
  const found = new Map<string, string>();
  for (const raw of reply.split(/\r?\n/)) {
    // A list marker, the prompt's backticks and bold around the id are formatting, not the verdict.
    const line = raw
      .replace(/^\s*(?:[-*+]\s+)?`(.*)`\s*$/, "$1")
      .replaceAll("**", "")
      .replace(/^[\s`*+-]+/, "")
      .trim();
    for (const id of ids) {
      if (found.has(id)) continue;
      // "not met" first: an id is never read as "<id> not" with a met verdict.
      const verdict = line.startsWith(`${id} not met: `)
        ? "not met"
        : line.startsWith(`${id} met: `)
          ? "met"
          : undefined;
      if (verdict === undefined) continue;
      const text = oneLine(line.slice(`${id} ${verdict}: `.length), 300);
      if (text === "") continue;
      found.set(
        id,
        verdict === "met" && !namedPaths(text).some((p) => headFiles.has(p))
          ? `- ${id} not met: the check named no file present at ${head.slice(0, 12)}`
          : `- ${id} ${verdict}: ${text}`,
      );
    }
  }
  return ids.map((id) => found.get(id) ?? `- ${id} not met: no verdict was reported`);
}

/** Every requirement not met, for a check that did not run. */
export function notRunLines(ids: string[], why: string): string[] {
  return ids.map(
    (id) => `- ${id} not met: the requirement check did not run (${oneLine(why, 200)})`,
  );
}

/** The block, carrying the manifest's sha256: the approval's pin, never a recomputed hash. */
export function renderSpecBlock(spec: Pick<IssueSpec, "link" | "sha256">, lines: string[]): string {
  return [SPEC_OPEN, `Spec: ${spec.link} sha256:${spec.sha256}`, ...lines, SPEC_CLOSE].join("\n");
}

/** Why a host could not read the body's block; `undefined` when it can. */
export function specBlockProblem(body: string): string | undefined {
  const lines = outsideFences(body).map((l) => l.trim());
  const opens = lines.flatMap((l, i) => (l === SPEC_OPEN ? [i] : []));
  const closes = lines.flatMap((l, i) => (l === SPEC_CLOSE ? [i] : []));
  if (opens.length === 0) return "no tehas:spec v1 block outside a fence";
  if (opens.length > 1 || closes.length > 1) return "more than one tehas:spec block";
  const open = opens[0] as number;
  const close = closes[0];
  if (close === undefined || close < open) return "the tehas:spec block is not closed";
  const [specLine, ...reqs] = lines.slice(open + 1, close);
  if (specLine === undefined || !/^Spec: \S+ sha256:[0-9a-f]{64}$/.test(specLine))
    return "the Spec: line is missing or malformed";
  if (reqs.length === 0) return "the block has no requirement line";
  const seen = new Set<string>();
  for (const line of reqs) {
    const colon = line.indexOf(":");
    const head = line.slice(0, colon);
    const m = /^- (.*?) (not met|met)$/.exec(head);
    const id = m?.[1] ?? "";
    if (colon < 0 || !m || id.trim() === "" || id.includes("`"))
      return `not a requirement line: ${oneLine(line, 80)}`;
    if (!line.startsWith(": ", colon) || line.slice(colon + 2).trim() === "")
      return `requirement ${id} has no text`;
    if (seen.has(id)) return `requirement ${id} is named twice`;
    seen.add(id);
  }
  return undefined;
}
