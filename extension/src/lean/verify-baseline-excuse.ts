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
import { classifyFailureLine, failureLines } from "../work-driver-verify-failures.ts";
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
function identitiesOfLine(line: string): TestIdentity[] {
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
  const token = stripTrailingReason(stripped);
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
    return /^\s*not\s+ok\b[^\S\n]*(?:[0-9]+[^\S\n]*-[^\S\n]*)?(.*)$/is.exec(line)?.[1];
  // Every remaining `namesTest: true` shape (`diagnostic`, `named-file`,
  // `script-tally`, `fail-header`, `assertion-mark`, the payload marker) carries
  // prose rather than a test identity, and comparing prose between two runs would
  // be comparing messages, not tests. They name nothing here.
  return undefined;
}

/** Drop a runner's trailing ` - <reason>` from an identity token. */
function stripTrailingReason(token: string): string {
  return (token.split(" - ")[0] ?? "").trim();
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
 * Is the name the SAME test in both trees?
 *
 * The two runs print the SAME project-relative path — one ran in the run's
 * worktree, the other in a throwaway checkout of the base — so equality is the
 * equality of the two RELATIVE names, with each side first normalised (back
 * slashes, `.` segments, a leading `./`) and each side anchored through its OWN
 * tree to catch a spelling that escapes it (a name printed as an absolute path, or
 * under the other tree's prefix, is not placeable and never matches). There is no
 * shared-tail branch: a tail match only ever excuses, so `p/q/r/tests/x.py` would
 * excuse `tests/x.py`.
 *
 * The two roots must be DIFFERENT directories. If they are the same tree, or two
 * spellings of it, every name matches its own echo and the comparison proves
 * nothing about which run printed what — that is `unknown`, never a match.
 */
function sameTest(
  headPath: string,
  basePath: string,
  headRest: string,
  baseRest: string,
  roots: { headRoot: string; probeRoot: string },
): boolean {
  if (headRest !== baseRest) return false;
  const headRoot = treeRoot(roots.headRoot);
  const probeRoot = treeRoot(roots.probeRoot);
  if (headRoot === probeRoot) return false;
  const headRel = relativeWithin(headRoot, headPath);
  const baseRel = relativeWithin(probeRoot, basePath);
  if (headRel === undefined || baseRel === undefined) return false;
  return headRel.length > 0 && headRel === baseRel;
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

/** Does `name` appear in `base`? Path halves are anchored, everything else is exact. */
function nameMatches(
  name: TestIdentity,
  base: readonly TestIdentity[],
  roots: { headRoot: string; probeRoot: string },
): boolean {
  const [headPath = "", ...headRest] = name.name.split("::");
  for (const candidate of base) {
    if (candidate.pathBearing !== name.pathBearing) continue;
    if (!name.pathBearing) {
      if (candidate.name === name.name) return true;
      continue;
    }
    const [basePath = "", ...baseRest] = candidate.name.split("::");
    // There is no shared-tail branch: a tail match only ever excuses, so
    // `p/q/r/tests/x.py` would excuse `tests/x.py`.
    const ok = sameTest(headPath, basePath, headRest.join("::"), baseRest.join("::"), roots);
    if (ok) return true;
  }
  return false;
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
  const roots = { headRoot: opts.headRoot, probeRoot: opts.probeRoot };
  if (!head.every((name) => nameMatches(name, base, roots))) return { kind: "refused" };
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
    .map((name) => (name.includes("::") ? `FAILED ${name}` : `not ok - ${name}`))
    .join("\n");
}
