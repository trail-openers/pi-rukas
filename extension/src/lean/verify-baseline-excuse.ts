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
 *   - names come ONLY from the shapes in `work-driver-verify-shapes.ts` whose
 *     entry declares `namesTest: true`, read through `failureLines` /
 *     `classifyFailureLine` so the per-line 8 KiB scan window is the bound here
 *     too. A stream whose only failing line sits past that window names nothing,
 *     and a stream that names nothing excuses nothing;
 *   - both sets must be non-empty and EVERY head name must match a base name.
 *     One unmatched name is a failure this run authored, and `unknown` from
 *     `compareNames` counts as unmatched — never as a match;
 *   - path-bearing identities (pytest's `path::name`) are anchored against the
 *     tree each run actually executed in and the two remainders must be EQUAL —
 *     a shared tail never excuses anything. The `::name` half and every non-path
 *     identity (go's `TestFoo`, a TAP description) compare by exact string
 *     equality; an unplaceable name counts as unmatched, never as a match;
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
} from "./state-outcome-maps.ts";
import { type BaseProbe, baselineRedReason } from "./verify-baseline.ts";

/** The name of a failing check as one stream printed it, plus how it is compared. */
export interface TestIdentity {
  /** The identity token: pytest `path::name`, a go test name, or a TAP description. */
  name: string;
  /** Whether the token's first half is a path to be anchored, or a bare name. */
  pathBearing: boolean;
}

/** Why the base red cannot excuse this tier's red. */
export type BaselineExcuse =
  | { kind: "excused"; record: PreexistingTierRecord }
  | { kind: "refused" };

/** The identity tokens one failure line carries (a runner may pack several onto one). */
function identitiesOfLine(candidate: string): TestIdentity[] {
  // ONE clip for the whole line, then every parser below reads the clipped text:
  // the classifier bounds its own view, but the identity parsers reach into the
  // line's LAST characters, so an over-long candidate handed to them unclipped
  // would make those tails scan the whole string.
  const line = clipForScan(candidate);
  const verdict = classifyFailureLine(line);
  if (verdict === undefined || !verdict.namesTest) return [];
  if (verdict.shape === "pytest-failed" || verdict.shape === "pytest-error") {
    // Each `; `-separated span of a packed line is its own test, with the shape's
    // own marker stripped from every span (`FAILED a::t; FAILED b::u`) — a token
    // that kept the marker, or swallowed the second failure, would match nothing
    // at base and the excuse would be refused over a formatting fact.
    const spans = /^\s*(?:FAILED|ERROR)\s+(.*)$/s.exec(line)?.[1] ?? "";
    return spans
      .split(";")
      .map((token) => stripTrailingReason(stripMarker(token.trim())))
      .filter((token) => token.includes("::"))
      .map((token) => ({ name: token, pathBearing: true }));
  }
  const stripped = stripShapePrefix(line, verdict.shape);
  if (stripped === undefined) return [];
  // A bare identity is compared WHOLE. The ` - ` a runner puts between a name and
  // its failure text is not a delimiter here: cutting at the first one makes
  // `checkout - expected 3 got 4` and `checkout - other assertion` one name, and a
  // failure only this run authored is then excused as pre-existing — the one thing
  // this feature must never do. If the two runs word the reason differently the
  // excuse is refused and today's red stands, which is the safe direction.
  const token = stripped.trim();
  return token === "" ? [] : [{ name: token, pathBearing: token.includes("::") }];
}

/** A repeated shape marker on a span of a packed failure line (`FAILED a::t; FAILED b::u`). */
function stripMarker(token: string): string {
  return /^\s*(?:FAILED|ERROR)\s+(.*)$/s.exec(token)?.[1] ?? token;
}

/** The line with its shape's leading marker removed, or `undefined` for no marker. */
function stripShapePrefix(line: string, shape: string): string | undefined {
  if (shape === "pytest-failed" || shape === "pytest-error") {
    const rest = /^\s*(?:FAILED|ERROR)\s+(.*)$/s.exec(line)?.[1];
    return rest === undefined || !rest.includes("::") ? undefined : rest;
  }
  if (shape === "go-fail") return /^\s*---\s+FAIL:\s+(.*)$/s.exec(line)?.[1];
  if (shape === "tap-not-ok")
    // Two INDEPENDENT optionals: the number, and the ` - ` the harness puts between
    // number and description. `not ok 1 - x`, `not ok 1 x`, `not ok - x` and
    // `not ok x` are four spellings of one identity and must yield the SAME token —
    // one optional group tying the separator to the number made the unnumbered
    // spelling keep its leading `- `, and a name that reads back differently never
    // matches the token the other run recorded.
    return /^\s*not\s+ok\b[^\S\n]*(?:[0-9]+[^\S\n]*)?(?:-[^\S\n]*)?(.*)$/is.exec(line)?.[1];
  // Every remaining `namesTest: true` shape (`diagnostic`, `named-file`,
  // `script-tally`, `fail-header`, `assertion-mark`, the payload marker) carries
  // prose rather than a test identity, and comparing prose between two runs would
  // be comparing messages, not tests. They name nothing here.
  return undefined;
}

/**
 * Drop pytest's trailing ` - <reason>` from an identity token.
 *
 * Safe ONLY for the path-bearing arm: pytest's identity is the `path::name` before
 * the reason, so the cut cannot merge two different tests. The non-path arm does not
 * call it — see {@link identitiesOfLine}.
 */
function stripTrailingReason(token: string): string {
  return (token.split(" - ")[0] ?? "").trim();
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
 * Every failing test this stream names, in stream order, read ONLY through the
 * shapes whose table entry declares `namesTest: true`.
 *
 * Exported because the caller keeps both runs' streams and must ask the same
 * question of each. Deduplicated: a runner repeats a summary line, and a set that
 * counted the repeat would report a failing count the tier did not have.
 */
export function testIdentitiesOf(stream: string): TestIdentity[] {
  const seen = new Set<string>();
  const out: TestIdentity[] = [];
  for (const line of failureLines(stream)) {
    for (const identity of identitiesOfLine(line)) {
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
 * Two indexes, because the two kinds of identity are compared differently:
 *
 *   - `bare` holds every non-path identity (a go `TestFoo`, a TAP description) and is
 *     answered by exact string equality, which is what the unindexed loop did;
 *   - `anchored` holds the path-bearing identities keyed by the project-relative
 *     name each one anchors to INSIDE THE BASE TREE. A head name looks up its own
 *     anchored remainder and a match is a key hit, so the hundreds of candidates a
 *     chatty suite prints are never each anchored against the head.
 *
 * A base identity whose path half is not placeable in the probe tree is indexed
 * under no key: it is not placeable, so it can stand for nothing — the same answer
 * the unindexed loop gave, where `relativeWithin` refused it.
 */
interface BaseIndex {
  bare: Set<string>;
  anchored: Map<string, Set<string>>;
}

/** Index the base set once for one comparison; see {@link BaseIndex}. */
function indexBase(base: readonly TestIdentity[], roots: TreePair): BaseIndex {
  const bare = new Set<string>();
  const anchored = new Map<string, Set<string>>();
  for (const identity of base) {
    if (!identity.pathBearing) {
      bare.add(identity.name);
      continue;
    }
    const [basePath = "", ...baseRest] = identity.name.split("::");
    const rel = relativeWithin(roots.probeRoot, basePath);
    if (rel === undefined || rel === "") continue;
    const rest = baseRest.join("::");
    const bucket = anchored.get(rel);
    if (bucket === undefined) anchored.set(rel, new Set([rest]));
    else bucket.add(rest);
  }
  return { bare, anchored };
}

/**
 * Does `name` appear in `base`? Path halves are anchored, everything else is exact.
 *
 * A head identity whose path half is not placeable in the run's own tree matches
 * nothing — there is no project-relative name to look up, and guessing one from a
 * tail is exactly the shared-tail match this module refuses.
 */
function nameMatches(name: TestIdentity, index: BaseIndex, roots: TreePair): boolean {
  if (!name.pathBearing) return index.bare.has(name.name);
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
 * parse than a fresh probe would have used.
 */
export function baseStreamOf(names: readonly string[]): string {
  return names
    .map((name) => (name.includes("::") ? `FAILED ${name}` : `not ok 1 - ${name}`))
    .join("\n");
}
