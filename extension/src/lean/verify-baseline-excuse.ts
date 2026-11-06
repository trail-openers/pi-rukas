/**
 * lean/verify-baseline-excuse — a tier red at HEAD whose every failing test is
 * ALSO red at the run's base commit is not this run's failure.
 *
 * `verify-baseline.ts` asks whether the base is red at all and hands the run
 * back when it is. That answer is correct but expensive: a mainline whose own
 * suite is red on this host hands back every run of a perfectly good change, and
 * a build round could not fix a gate the base authored. This module asks the
 * narrower question — WHICH tests fail on each side — and answers "grade it
 * green, and say so" when the head run named nothing the base run did not name.
 *
 * It is deliberately stricter than "the base was red too":
 *
 *   - names come ONLY from pytest's own failing lines — the `pytest-failed` /
 *     `pytest-error` shapes in `work-driver-verify-shapes.ts` — read through
 *     `failureLines` / `classifyFailureLine` so the per-line 8 KiB scan window is
 *     the bound here too. A stream whose only failing line sits past that window
 *     names nothing, and a stream that names nothing excuses nothing;
 *   - **the identity is pytest's `path::name`, and nothing else.** Every other
 *     runner's failing line was tried and removed: no parser for a TAP description
 *     or a go test name survived three reviews without finding a new way to fold
 *     two different checks onto one token — cutting at the runner's ` - ` merged
 *     `checkout - expected 3 got 4` with `checkout - other assertion`, and an
 *     optional test-number group merged `not ok 1 - 1 - boom` with
 *     `not ok 2 - 1 - boom`. A folded name excuses a failure only this run
 *     authored, which is the one thing this feature must never do. So an identity
 *     must carry a path and a `::` — two facts no field-observed pytest line
 *     prints differently between two runs of one tree — and a stream that yields
 *     ANY identity without one refuses the excuse outright, rather than comparing
 *     tokens that might be one check spelled two ways or two checks spelled one;
 *   - a line whose trimmed text starts with `FAILED ` or `ERROR ` is pytest declaring a
 *     failing test, so it must yield a readable identity even where the classifier
 *     recognises nothing: `ERROR tests/x.py` (a collection error, no `::`) and a bare
 *     `FAILED tests/y.py` excuse nothing — dropping one grades a tier green on a failure
 *     the base never printed.
 *   - both sets must be non-empty and EVERY head name must match a base name.
 *     One unmatched name is a failure this run authored, and `unknown` from
 *     `compareNames` counts as unmatched — never as a match;
 *   - identities are anchored against the tree each run actually executed in and
 *     the two remainders must be EQUAL — a shared tail never excuses anything, and
 *     the `::name` half compares by exact string equality; an unplaceable name
 *     counts as unmatched, never as a match;
 *   - a base run whose red looks like a missing dependency tree is not evidence
 *     the commit is red, it is evidence the probe was not provisioned.
 *
 * "Could not tell" is never an excuse, and the caller falls back to exactly the
 * hand-back `verify-baseline.ts` produced before this module existed.
 */

import { realpathSync } from "node:fs";
import {
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine,
  failureLines,
} from "../work-driver-verify-failures.ts";
import {
  PREEXISTING_BASE_NAMES_CAP,
  PREEXISTING_NAMES_CAP,
  type PreexistingTierRecord,
  preexistingFailuresProblem,
} from "./state-outcome-maps.ts";
import { type BaseProbe, baselineRedReason } from "./verify-baseline.ts";

/** A failing test as one stream printed it: pytest's `path::name`, anchored by its path half. */
export interface TestIdentity {
  /** The identity token: pytest's `path::name`, with its trailing ` - <reason>` removed. */
  name: string;
}

/** Why the base red cannot excuse this tier's red. */
export type BaselineExcuse =
  | { kind: "excused"; record: PreexistingTierRecord }
  | { kind: "refused" };

/** The identity tokens one failure line carries (a runner may pack several onto one). */
function identitiesOfLine(candidate: string): LineIdentities {
  // ONE clip for the whole line, then every parser below reads the clipped text: the
  // classifier bounds its own view, but the identity parsers reach into the line's LAST
  // characters, so an over-long candidate handed to them unclipped would scan it all.
  const unreadable: LineIdentities = { identities: [], unreadable: true };
  const line = clipForScan(candidate.trim());
  const verdict = classifyFailureLine(line);
  // A marker at the line's head is pytest declaring a failing test, so an unrecognised
  // line still owes a readable identity rather than going uncounted.
  if (verdict === undefined || !verdict.namesTest) {
    return DECLARED_FAILURE.test(line) ? unreadable : { identities: [], unreadable: false };
  }
  if (verdict.shape !== "pytest-failed" && verdict.shape !== "pytest-error") return unreadable;
  // Each span of a packed line is its own test, with the shape's own marker stripped
  // from every span (`FAILED a::t; FAILED b::u`). SPLIT ONLY ON A `;` AT BRACKET DEPTH 0
  // WHOSE NEXT SPAN STARTS WITH THE MARKER: a bare `;` is legal inside a parametrisation
  // (`a.py::t[x; 1]`), and splitting there cuts the token in half, which then stands for
  // every other value of that parameter.
  const spans = /^\s*(?:FAILED|ERROR)\s+(.*)$/s.exec(line)?.[1] ?? "";
  const tokens = splitPackedSpans(spans).map((span) => stripTrailingReason(stripMarker(span)));
  // A failure line whose token this module cannot read is a failing test it cannot NAME,
  // and an unnamed failure must never be excused. Dropping the token instead would let a
  // head of `[readable A, unreadable B]` match a base that named only A and grade the
  // tier green on a failure this run authored, so one unreadable token refuses the WHOLE
  // excuse — on either stream — rather than going uncounted.
  if (tokens.some((token) => !balanced(token) || !token.includes("::"))) return unreadable;
  return { identities: tokens.map((token) => ({ name: token })), unreadable: false };
}

/** What one failure line yielded: the identities it names, and whether it named one it could not read. */
interface LineIdentities {
  identities: TestIdentity[];
  /** A line that declares a failing test this module could not identify. */
  unreadable: boolean;
}

/** Where a packed failure line separates one test from the next: a `;` before a marker. */
const PACKED_SPAN = /;\s*(?=(?:FAILED|ERROR)\s)/;

/** A line pytest itself opened: its own word for a test that did not pass. */
const DECLARED_FAILURE = /^(?:FAILED|ERROR)\s/;

/** The shapes whose tokens {@link identitiesOfLine} parses. */
const PYTEST_SHAPES = new Set(["pytest-failed", "pytest-error"]);

/**
 * The spans of one packed failure line.
 *
 * A `;` is a span boundary only at BRACKET DEPTH 0 and only when the next span opens
 * with the runner's own marker (see {@link PACKED_SPAN}); together they keep
 * `a.py::t[x; 1]; a.py::t[x; 2]` one test where a bare split makes two truncated ones.
 */
function splitPackedSpans(spans: string): string[] {
  return spans
    .split(PACKED_SPAN)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Are every kind of bracket in this token closed, and closed in the right order? */
function balanced(token: string): boolean {
  // The two tables are indexed BY KIND, so the close bracket at index N belongs to the
  // open bracket at index N — tables that do not line up refuse every `t[x]`
  // parametrisation as unreadable, which switches the feature off on the runner it exists
  // for. ONE STACK, not a counter per kind: a `(` closed by `]` is as unreadable as a `(`
  // never closed at all, and counters cannot see the difference.
  const OPEN = ["(", "[", "{"] as const;
  const CLOSE = [")", "]", "}"] as const;
  const stack: string[] = [];
  for (const ch of token) {
    if (OPEN.some((bracket) => bracket === ch)) {
      stack.push(ch);
      continue;
    }
    const close = CLOSE.findIndex((bracket) => bracket === ch);
    if (close < 0) continue;
    if (stack.pop() !== OPEN[close]) return false;
  }
  return stack.length === 0;
}

/** A repeated shape marker on a span of a packed failure line (`FAILED a::t; FAILED b::u`). */
function stripMarker(token: string): string {
  return /^\s*(?:FAILED|ERROR)\s+(.*)$/s.exec(token)?.[1] ?? token;
}

/**
 * Does this stream name a failing check this module cannot identify?
 *
 * One non-pytest identity is enough to refuse the whole excuse. A runner this
 * module cannot name — TAP, go, a script tally, a bare `error:` — still exits
 * non-zero, and excusing a tier that printed such a line beside its pytest output
 * would wave the unnamed failures through with the named ones. `testIdentitiesOf`
 * skips those shapes rather than parsing them, so this asks the SHAPES directly:
 * anything that declares it names a test and is not a pytest line is a name this
 * module does not read, and the caller keeps today's red.
 *
 * It walks the RAW stream lines: `failureLines` classifies first, so an unrecognised
 * `FAILED tests/y.py` or `ERROR tests/test_new.py` never reaches its output.
 */
function namesUnreadableIdentity(stream: string): boolean {
  for (const line of stream.split(/\r\n|\r|\n/)) {
    // Asked of every line, recognised or not: an unrecognised one is judged by its marker.
    const verdict = classifyFailureLine(clipForScan(line));
    if (verdict?.namesTest === true && !PYTEST_SHAPES.has(verdict.shape)) return true;
    if (identitiesOfLine(line).unreadable) return true;
  }
  return false;
}

/**
 * Drop pytest's trailing ` - <reason>` from an identity token.
 *
 * A trailing reason is delimited by WHITESPACE (` - `), so the cut is taken at the
 * FIRST such separator at BRACKET DEPTH 0 — the depth count is the only way to tell
 * pytest's own separator from one that lives inside the parametrisation. Cutting at the
 * LAST one leaked the reason into the identity (`a.py::t - assert 1 - 2` read as
 * `a.py::t - assert 1`), and cutting at the first ` - ` anywhere would fold
 * `test_total[EUR - 3.99]` and every sibling value onto the one token before the
 * separator — excusing a failure only this run authored. A token with no depth-0
 * separator stays whole. Whatever the cut leaves behind must still balance its brackets
 * (see {@link balanced}); a token that does not is unreadable, and the caller refuses
 * the excuse rather than comparing a truncated identity.
 */
function stripTrailingReason(token: string): string {
  const cut = bracketDepth(token);
  return cut === undefined || cut < 0 ? token.trim() : token.slice(0, cut).trim();
}

/**
 * The token's first ` - ` that sits at bracket DEPTH 0, or -1 when it carries none.
 *
 * `undefined` for a token whose brackets never balance: an unclosed or mismatched one is
 * a cut, not a name. A separator still inside a parametrisation (`[EUR - 3.99]`) is part
 * of the test's own name, not pytest's delimiter, and cutting there folds every sibling
 * value of that parameter onto one token.
 */
function bracketDepth(token: string): number | undefined {
  let depth = 0;
  let firstSeparatorAt = -1;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return undefined;
      depth--;
      continue;
    }
    if (depth === 0 && firstSeparatorAt < 0 && token.startsWith(" - ", i)) firstSeparatorAt = i;
  }
  return depth === 0 ? firstSeparatorAt : undefined;
}

/**
 * One candidate line clipped to the scan window BEFORE anything reads it.
 *
 * The same bound `work-driver-verify-full.ts`'s `clipForScanSlice` applies to a
 * packed slice: a pathological line costs the window and no more, in the classifier
 * and in the identity parsers alike.
 */
function clipForScan(line: string): string {
  return line.length > FAILURE_LINE_SCAN_MAX ? line.slice(0, FAILURE_LINE_SCAN_MAX) : line;
}

/**
 * Every failing test this stream names, in stream order — pytest's `path::name`
 * identities only, see {@link identitiesOfLine}.
 *
 * Exported because the caller keeps both runs' streams and must ask the same
 * question of each. Deduplicated: a runner repeats a summary line, and a set that
 * counted the repeat would report a failing count the tier did not have.
 */
export function testIdentitiesOf(stream: string): TestIdentity[] {
  const seen = new Set<string>();
  const out: TestIdentity[] = [];
  for (const line of failureLines(stream)) {
    for (const identity of identitiesOfLine(line).identities) {
      if (seen.has(identity.name)) continue;
      seen.add(identity.name);
      out.push(identity);
    }
  }
  return out;
}

/**
 * A tree resolved to the spelling its own run would have printed it under.
 *
 * `realpath` is not cosmetic: a tree reached through a symlink prints its names
 * under the symlinked spelling while the caller holds the resolved one (or the
 * reverse), and the two never share a prefix. macOS makes every temp dir a
 * symlink, so without this a whole run's names become unplaceable. Only the
 * LONGEST EXISTING PREFIX resolves — the probe's own tree is deleted before this
 * comparison runs, and resolving its parent still puts it in the same spelling as
 * every other path here.
 *
 * Called ONCE per {@link baselineExcuse} for each side, never per candidate: a
 * tier that names hundreds of tests asked this hundreds of times before.
 */
function treeRoot(dir: string): string {
  const parts = dir
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
  for (let i = parts.length; i >= 1; i--) {
    try {
      const head = realpathSync(`/${parts.slice(0, i).join("/")}`);
      const rest = parts.slice(i);
      const base = head.endsWith("/") ? head.slice(0, -1) : head;
      return rest.length === 0 ? base : `${base}/${rest.join("/")}`;
    } catch {
      // Shorten and try again.
    }
  }
  return `/${parts.join("/")}`;
}

/** The segments of a printed relative path: forward slashes, no `.` segments. */
function segments(value: string): string[] {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
}

/**
 * The two trees of one comparison, each resolved once, and refused if they are not
 * two trees.
 *
 * The two roots must be DIFFERENT directories. If they are the same tree, or two
 * spellings of it, every name matches its own echo and the comparison proves
 * nothing about which run printed what — the caller refuses the excuse rather than
 * grading a green on an identity's own echo.
 */
interface TreePair {
  headRoot: string;
  probeRoot: string;
}

/**
 * `path` relative to `root`, or `undefined` when it does not live under it.
 *
 * Both sides resolve through the longest existing prefix, so a probe tree the
 * probe already deleted still lands in the same spelling as every live path here.
 */
function relativeWithin(root: string, path: string): string | undefined {
  const parts = segments(path);
  if (parts.length === 0) return undefined;
  const joined = parts.join("/");
  const rootSegments = segments(root);
  if (rootSegments.length === 0) return undefined;
  // A name the runner printed as an absolute path inside its own tree, or already
  // relative: either way, strip the tree's own prefix when it is a leading run of
  // segments and keep the remainder as the project-relative name.
  const rooted =
    rootSegments.length <= parts.length && rootSegments.every((seg, i) => parts[i] === seg);
  const rel = rooted ? parts.slice(rootSegments.length).join("/") : joined;
  return rel === "" ? undefined : rel;
}

/**
 * The base set indexed for the subset test, so the test costs O(H+B) and not O(H*B).
 *
 * Keyed by the project-relative name each identity anchors to INSIDE THE BASE TREE.
 * A head name looks up its own anchored remainder and a match is a key hit, so the
 * hundreds of candidates a chatty suite prints are never each anchored against the
 * head.
 *
 * A base identity whose path half is not placeable in the probe tree is indexed
 * under no key: it is not placeable, so it can stand for nothing — the same answer
 * the unindexed loop gave, where `relativeWithin` refused it.
 */
interface BaseIndex {
  anchored: Map<string, Set<string>>;
}

/** Index the base set once for one comparison; see {@link BaseIndex}. */
function indexBase(base: readonly TestIdentity[], roots: TreePair): BaseIndex {
  const anchored = new Map<string, Set<string>>();
  for (const identity of base) {
    const [basePath = "", ...baseRest] = identity.name.split("::");
    const rel = relativeWithin(roots.probeRoot, basePath);
    if (rel === undefined || rel === "") continue;
    const rest = baseRest.join("::");
    const bucket = anchored.get(rel);
    if (bucket === undefined) anchored.set(rel, new Set([rest]));
    else bucket.add(rest);
  }
  return { anchored };
}

/**
 * Does `name` appear in `base`? Its path half is anchored, its `::name` half is exact.
 *
 * A head identity whose path half is not placeable in the run's own tree matches
 * nothing — there is no project-relative name to look up, and guessing one from a
 * tail is exactly the shared-tail match this module refuses.
 */
function nameMatches(name: TestIdentity, index: BaseIndex, roots: TreePair): boolean {
  const [headPath = "", ...headRest] = name.name.split("::");
  const headRel = relativeWithin(roots.headRoot, headPath);
  if (headRel === undefined || headRel === "") return false;
  const bucket = index.anchored.get(headRel);
  if (bucket === undefined) return false;
  // The `::name` half compares by exact string equality, as before; there is no
  // shared-tail branch, so `p/q/r/tests/x.py` never excuses `tests/x.py`.
  return bucket.has(headRest.join("::"));
}

/**
 * Is this base run's red the shape of a tree that was never provisioned?
 *
 * `worktree-provision`'s predicate is the vocabulary, but it is written for a single
 * failed gate and its "No such file or directory … node_modules" arm reads the two
 * phrases ANYWHERE in the stream. A tier's own `sh` trace can print both — an
 * interpreter line about a missing binary beside a pytest summary naming the file it
 * could not import — and an excuse may not be refused on text the tier printed ABOUT
 * a file. So a stream excuses nothing only when a FAILURE LINE is individually
 * dependency-shaped: the interpreter's own sentence, not a runner's summary.
 */
function baseRedIsMissingDeps(stream: string): boolean {
  return failureLines(stream).some((line) => MISSING_DEP_LINE.test(line));
}

/** One line the interpreter printed because the tree had no dependencies. */
const MISSING_DEP_LINE =
  /^\s*(?:sh|bash|zsh|npm|pnpm|yarn|bun|node|python\d*|pip\d*|go|cargo|make):\s|Cannot find module|ModuleNotFoundError|error: Cannot find package|command not found|Could not resolve\b/i;

/**
 * May this tier's red be excused over the base run's red?
 *
 * The caller has already settled the colour questions (HEAD red twice, base red,
 * the contract arm) and the frozen acceptance verdict. What is decided here is
 * whether the head run named anything the base did not; every refusal means the
 * caller keeps the hand-back `verify-baseline.ts` produced before this module.
 */
export function baselineExcuse(opts: {
  tierName: string;
  cmd: string;
  baseSha: string;
  /** The base run's colour, already classified by `classifyBaseRun`. */
  probe: BaseProbe;
  /** The head run's combined output stream (the final run of the tier). */
  headStream: string | undefined;
  /** The base run's combined output stream. */
  baseStream: string | undefined;
  /** The run's worktree — where the head run's relative paths live. */
  headRoot: string;
  /** The probe's throwaway tree — where the base run's relative paths lived. */
  probeRoot: string;
}): BaselineExcuse {
  if (opts.probe.status !== "red") return { kind: "refused" };
  const baseStream = opts.baseStream ?? "";
  const head = testIdentitiesOf(opts.headStream ?? "");
  const base = testIdentitiesOf(baseStream);
  // A bare checkout whose dependencies were never linked fails every command: that
  // red belongs to the probe's provisioning, not to the commit, and no name it
  // prints can stand as evidence the base was red.
  if (baseRedIsMissingDeps(baseStream)) return { kind: "refused" };
  // pytest identities only, on BOTH sides: see {@link namesUnreadableIdentity}.
  if (namesUnreadableIdentity(opts.headStream ?? "")) return { kind: "refused" };
  if (namesUnreadableIdentity(baseStream)) return { kind: "refused" };
  if (head.length === 0 || base.length === 0) return { kind: "refused" };
  // Both trees resolved ONCE for this comparison, and a probe tree that is the run's
  // own tree — or another spelling of it — compares against nothing.
  const headRoot = treeRoot(opts.headRoot);
  const probeRoot = treeRoot(opts.probeRoot);
  if (headRoot === probeRoot) return { kind: "refused" };
  const roots: TreePair = { headRoot, probeRoot };
  const index = indexBase(base, roots);
  if (!head.every((name) => nameMatches(name, index, roots))) return { kind: "refused" };
  // The subset test ran on the COMPLETE parsed sets; the caps below bound only what
  // is persisted and rendered. `baseNames` is what lets `ci` reuse this record
  // instead of paying for its own base probe, and an oversized one is omitted
  // rather than truncated: a partial base set would make ci's comparison a lie.
  const record: PreexistingTierRecord = {
    cmd: opts.cmd,
    names: head.map((n) => n.name).slice(0, PREEXISTING_NAMES_CAP),
    total: head.length,
    baseSha: opts.baseSha,
    ...(base.length <= PREEXISTING_BASE_NAMES_CAP ? { baseNames: base.map((n) => n.name) } : {}),
  };
  // The record is about to be WRITTEN to the step log, and the log's own reader
  // (`preexistingFailuresProblem`, applied by `loadRun`) refuses a name longer than
  // `PREEXISTING_NAME_MAX_CHARS` or carrying a control character — which the 8 KiB
  // scan-window clip can produce on its own, by cutting a name in the middle of an
  // astral character. A record the reader rejects is worse than no record: `saveRun`
  // writes it and `loadRun` then refuses the WHOLE run file, so the excuse would
  // take the run down with it. Ask the validator the question it will ask, and refuse
  // the excuse rather than persisting a record the run cannot be read back with.
  if (preexistingFailuresProblem({ [opts.tierName]: record }) !== undefined)
    return { kind: "refused" };
  return { kind: "excused", record };
}

/**
 * The tail a green carries when a tier was excused over the base commit.
 *
 * `publish` prints the verify reason in the PR body's Verification section, so a
 * tier the gate let go names itself here as well as in the body's own
 * pre-existing-failures section: the prose is the warning, the recorded field is
 * the evidence the body renders from.
 */
export function preexistingReason(names: readonly string[]): string {
  return `pre-existing failures on the base commit: ${names.join(", ")} — every failing test also fails at the run's base commit, so no build round can fix them and this run did not author them`;
}

/**
 * A base run's stream rebuilt from names that were read in another tree.
 *
 * `ci` reuses `verify`'s recorded base set rather than paying for its own probe, so
 * the names it holds are the only evidence left of what the base printed. Feeding
 * them back as pytest `FAILED` lines keeps ONE reader — {@link testIdentitiesOf} —
 * for both sides of the comparison, so a reuse cannot be graded on a different
 * parse than a fresh probe would have used. Every recorded name is a pytest
 * `path::name` by construction (see {@link baselineExcuse}), so the rebuilt stream
 * never carries the non-pytest shape that would refuse it.
 */
export function baseStreamOf(names: readonly string[]): string {
  return names.map((name) => `FAILED ${name}`).join("\n");
}
