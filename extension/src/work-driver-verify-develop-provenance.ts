/**
 * work-driver-verify-develop-provenance — the develop gate's data-provenance check.
 *
 * A develop child can commit a measurement record — a JSON or NDJSON file of per-task
 * results — whose `source` names a results file that never existed. The child then writes
 * a generator that renders the record from its own rows and reports the round trip as
 * proof. A round trip through a pure function says nothing about the record's INPUT, so
 * the claim is unfalsifiable by the review layer, and it is falsifiable by one git read.
 *
 * The rule: a data file the diff ADDS, whose value under a provenance key names a
 * repo-relative path, must name a path that EXISTS in the workstream's pinned commit.
 * Absence fails and the failure names file, key and path. Anything the gate cannot judge
 * is disclosed rather than failed — an unverifiable token (an absolute path, a URL, prose,
 * an over-cap corpus) is host provenance this build cannot see, and an unreadable probe is
 * "could not tell", never "absent".
 *
 * Five rules make that judgement safe to make:
 *
 *   1. **One ref, pinned first.** `readCommitOid` resolves the worktree's HEAD to a full
 *      sha BEFORE any other read, and that one value is the `head` of the added-file read
 *      and the ref of every existence probe. A gate that resolved its ref twice could
 *      judge a file list from one commit against a token set from another.
 *   2. **Only an executed `absent` fails.** `existsInCommit` throws for a non-full-sha ref
 *      and for any git fault, and reads an empty tree entry as absence; a probe that could
 *      not answer is a note, never a verdict — the split `specify-path.ts` itself draws.
 *   3. **The tokens are untrusted.** Every path, key and reason reaching a failure string
 *      or the PR body goes through `neutraliseMarkdownField`, which collapses newlines and
 *      neutralises marker and heading shapes: this gate reads a file the child authored and
 *      prints fragments of it into the pull request.
 *   4. **The walk is bounded.** One committed byte ceiling per file and one committed token
 *      cap per workstream; a corpus past either is disclosed as unverifiable rather than
 *      judged, because a truncated walk that still reported absence would be a failure
 *      invented by the bound.
 *   5. **The keys are one exported constant.** A generator that renames `source` to
 *      `sourceFile` is the evasion that constant exists to close: extending the set is a
 *      source edit, never config drift.
 *
 * The module is a leaf by policy: it imports no other develop-gate module, so adding this
 * check cannot widen the develop gate's dependency graph. `test-git-range-1153.ts` lists
 * it — every git read here is argv form under the module's own named bounds.
 */

import { neutraliseMarkdownField } from "./comment-evidence.ts";
import { isFullCommitSha } from "./commit-sha.ts";
import { readCommitOid } from "./git-oid-read.ts";
import { existsInCommit } from "./lean/specify-path.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { changedPaths, readCommittedProtectedPaths } from "./work-driver-protected-paths-read.ts";
import type { VerifyDevelopOutcomeOptions } from "./work-driver-verify-develop-options.ts";
import {
  type HostRootProbe,
  type HostRootVerdict,
  VERIFY_PROVENANCE_ROOT_ENV,
  declaredProvenanceRoot,
  probeHostRoot,
} from "./work-driver-verify-develop-provenance-root.ts";
import {
  PROVENANCE_KEYS,
  PROVENANCE_KEYS_V0_14_85,
  PROVENANCE_MAX_CANDIDATES_PER_VALUE,
  PROVENANCE_MAX_TOKENS,
  classifyToken,
  code,
  display,
  hostContextProblem,
  proseCandidatesOf,
} from "./work-driver-verify-develop-provenance-token.ts";
import {
  NDJSON_SUFFIX,
  type ProvenanceBudget,
  isDataFile,
  tokensOf,
} from "./work-driver-verify-develop-provenance-walk.ts";

/** The escape hatch; read at call time, off only for the literal `"0"`. */
export const VERIFY_PROVENANCE_ENV = "PI_ENSEMBLE_VERIFY_PROVENANCE";

/** The prose arm's switch. Its name is exported rather than inlined so the docs row, the headless
 * input registration and the tests all name one string. */
export const VERIFY_PROVENANCE_PROSE_ENV = "PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE";

// The host-root knob's name lives with the seam that reads it (the root module); re-exported
// here so the gate's two #2295 knobs and the whole-value switch are named from one module, which
// is where docs/configuration.md, headless/inputs-b.ts and the switch tests all look.
export { VERIFY_PROVENANCE_ROOT_ENV } from "./work-driver-verify-develop-provenance-root.ts";

/** True unless the operator set {@link VERIFY_PROVENANCE_ENV} to exactly `"0"`. */
export function verifyProvenanceEnabled(): boolean {
  return !verifySwitchOff(process.env[VERIFY_PROVENANCE_ENV]);
}

/** The prose arm's own switch, read at call time like the gate's. On unless the operator set
 * {@link VERIFY_PROVENANCE_PROSE_ENV} to exactly `"0"`, which restores the v0.14.85 walk — the
 * seven-name key set and no splitting — so the arm can be turned off without turning off the
 * gate that catches a bare absent path. */
export function verifyProvenanceProseEnabled(): boolean {
  return !verifySwitchOff(process.env[VERIFY_PROVENANCE_PROSE_ENV]);
}

/** The note the prose arm leaves when its switch says off. A disabled arm is never a silent
 * green: this row is what distinguishes "the sentences were not judged" from "they passed". */
export const PROVENANCE_PROSE_DISABLED_NOTE =
  "PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE=0 — prose claims in provenance fields were not judged";
/** The note {@link verifyProvenanceEnabled} answers with when the gate is off. An off run is
 * never a silent green: this row is what distinguishes it from a judged one. */
export const PROVENANCE_DISABLED_NOTE =
  "PI_ENSEMBLE_VERIFY_PROVENANCE=0 — data-provenance gate disabled";

/**
 * The one switch spelling each develop gate answers: exactly `"0"` turns it off.
 *
 * Deliberately narrower than a general truthy parser. The gates are on by default and the
 * only supported way to turn one off is the exact string `0`; every other value — `false`,
 * `no`, `off`, a padded ` 0 `, a typo, the empty string — keeps the gate on, so a misspelled
 * disable can never read as a deliberate one. That is the same rule every other `PI_ENSEMBLE_*` kill-switch in the
 * driver answers, and a wider parser here would be a switch the develop child could turn off
 * by putting a value in the environment it controls.
 */
export function verifySwitchOff(raw: string | undefined): boolean {
  return raw === "0";
}

/**
 * The keys whose string values are read as provenance, at any nesting depth — re-exported
 * from the token module, which is where the constant lives so the walker and this gate read
 * one set rather than two that can drift.
 *
 * ONE constant, because the field case this gate exists for is a generator that renames
 * the key: a set that lived in config would be a set a child could widen. A key missing
 * there is a gap in that list, not a format the gate failed to detect.
 */
export {
  PROVENANCE_KEYS,
  PROVENANCE_KEYS_V0_14_85,
  PROVENANCE_MAX_TOKENS,
} from "./work-driver-verify-develop-provenance-token.ts";

/** The wall clock on this module's own git reads (the OID pin and the added-file range). */
export const PROVENANCE_GIT_TIMEOUT_MS = 30_000;
/** Byte ceiling on one added data file. Past it the file is disclosed, never judged. It is
 * also the ceiling that read's own executor buffer is set from, plus headroom: the bound is
 * what makes an over-large record a disclosure rather than a hang, and there is one number so
 * the two cannot disagree about what the gate is willing to read. */
export const PROVENANCE_FILE_MAX_BYTES = 1024 * 1024;

/** The leading clause every provenance failure carries, so the gate's own rows are
 * findable in a failure list and no cap router can mistake one for a verify verdict. */
export const PROVENANCE_FAILURE_PREFIX = "data provenance:";

/** The leading clause of this gate's "could not tell" notes. */
export const PROVENANCE_NOTE_PREFIX = "data provenance:";
/** The prefix of the note an executed pass leaves behind, carrying what it judged. */
export const PROVENANCE_CHECKED_NOTE = `${PROVENANCE_NOTE_PREFIX} judged`;

/** The prefix of the note a run that could not judge leaves behind. */
export const PROVENANCE_NOT_CHECKED_PREFIX = `${PROVENANCE_NOTE_PREFIX} NOT CHECKED`;

/** The worktree-side read this gate issues. Absent = this caller does not route on it. */
export type ProvenanceDisclosureSink = {
  /** Filled IN PLACE, as `verifyRecord` is, so the caller reads the same array it handed
   * in after the gate ran. Each entry is one judgement this gate could not make. */
  disclosures?: ProvenanceDisclosure[];
};

/** One judgement the gate declined to make, for the PR body. */
export interface ProvenanceDisclosure {
  /** The added data file, repo-relative, as a display field. */
  file: string;
  /** The provenance key the value sat under, as a display field; absent for a whole-file
   * refusal (unparsable bytes, a corpus over the bounds). */
  key?: string;
  /** The token as a display field, absent for a whole-file refusal. */
  token?: string;
  /** Why the gate declined. Its own words, never an interpolated raw token. */
  reason: string;
}

/** What one workstream's run produced. `judged` is the count of probes actually asked of
 * git; it is how a test tells an executed pass from a pass that ran nothing. */
export interface ProvenanceWorkstreamResult {
  failures: string[];
  notes: string[];
  disclosures: ProvenanceDisclosure[];
  /** Probes actually asked of git — how a caller tells an executed pass from a pass that
   * judged nothing. `judgedLabel` is the only place its sentence is written, so the count
   * in the note cannot drift from the probes this run asked for. */
  judged: number;
  judgedLabel: (workstreamId: string) => string;
}

/** The kinds of read a token probe can decline, kept distinct from "absent". */
type ProbeVerdict = "present" | "absent" | "unreadable";

/** Read one added file at the pinned commit. Absence of the blob is unreadable, not empty. */
async function readAddedFile(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  cwd: string,
  oid: string,
  file: string,
): Promise<{ ok: true; content: string } | { ok: false; why: string }> {
  try {
    const ran = await execFn("git", {
      argv: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "show",
        "--end-of-options",
        `${oid}:${file}`,
      ],
      cwd,
      timeout: PROVENANCE_GIT_TIMEOUT_MS,
      maxBuffer: PROVENANCE_FILE_MAX_BYTES + 64 * 1024,
    });
    return { ok: true, content: ran.stdout ?? "" };
  } catch (err) {
    return {
      ok: false,
      why: `could not read the committed blob (${(err as Error).message?.slice(0, 100)})`,
    };
  }
}

async function probeToken(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  cwd: string,
  oid: string,
  probe: string,
): Promise<ProbeVerdict> {
  try {
    return (await existsInCommit(execFn, cwd, oid, probe)) ? "present" : "absent";
  } catch (err) {
    trace(`provenance: probe failed for ${probe.slice(0, 80)}: ${(err as Error).message}`);
    return "unreadable";
  }
}

/** Byte ceiling on the whole-tree listing a bare-basename probe is answered from. Generous
 * against a real repository's path list (a path name costs a fraction of the file it names, so
 * this holds far more entries than the file ceiling holds bytes) and small enough that the read
 * is bounded work rather than an unbounded walk of an enormous tree. */
export const PROVENANCE_TREE_MAX_BYTES = 8 * 1024 * 1024;

/** How one candidate is looked for in the pinned commit.
 *
 * A candidate that spells a directory out claims a PATH and is answered by the shipped
 * exact-path read. A candidate with no directory component claims only that a file of that
 * name was read — which is how a measurement record cites its own results file (`out.ndjson`,
 * `summary.json`) — and is answered from the pass's cached tree listing. The two are not
 * interchangeable: an exact-path probe of a name that lives under `deep/nested/` reports
 * absence, and failing a record for a directory it never named would be the gate inventing a
 * requirement. The rule is not gated on the prose switch, because the claim a bare name makes
 * is the same claim whether or not the value was split out of a sentence.
 */
async function probeCandidate(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  cwd: string,
  oid: string,
  probe: string,
  treePaths: () => Promise<{ ok: true; paths: Set<string> } | { ok: false; why: string }>,
  basenameArm: boolean,
): Promise<ProbeVerdict> {
  if (probe.includes("/") || !basenameArm) return await probeToken(execFn, cwd, oid, probe);
  const tree = await treePaths();
  if (!tree.ok) return "unreadable";
  return basenamePresent(tree.paths, probe) ? "present" : "absent";
}

/** Does any path in this listing carry `name` as its final component? Compared component-wise,
 * so `out.ndjson` is named by `deep/nested/out.ndjson` and not by `deep/nested/xout.ndjson`. */
function basenamePresent(paths: ReadonlySet<string>, name: string): boolean {
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (base === name) return true;
  }
  return false;
}

/**
 * The pinned tree's paths, read ONCE per workstream and cached — the read a bare-basename probe
 * is answered from.
 *
 * A bare basename claims only that a file of that name was read; answering it with a pathspec
 * would be wrong, because git filters a `ls-tree <ref> -- <pathspec>` from the tree root and a
 * name that lives under `deep/nested/` matches nothing. So a basename claim is answered by a
 * tree-wide listing, and a listing is read ONCE: the alternative is one recursive `ls-tree` per
 * candidate, and a record citing a dozen file names would buy a dozen full-tree walks.
 *
 * The cost ceiling is deliberate and it fails closed toward disclosure. A tree whose entry bytes
 * exceed it is not partially listed and not silently truncated: the pass says it could not tell
 * and the candidates a basename probe would have answered stay unjudged. A listing that stopped
 * halfway and then reported absence would fail a record for a file the gate never looked at, and
 * an unreadable listing is never a verdict in either direction.
 */
async function readTreePaths(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  cwd: string,
  oid: string,
): Promise<{ ok: true; paths: Set<string> } | { ok: false; why: string }> {
  if (!isFullCommitSha(oid))
    return { ok: false, why: `\`${oid.slice(0, 20)}\` is not a full commit sha` };
  try {
    const ran = await execFn("git", {
      argv: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        "--name-only",
        "--end-of-options",
        oid,
      ],
      cwd,
      timeout: PROVENANCE_GIT_TIMEOUT_MS,
      maxBuffer: PROVENANCE_TREE_MAX_BYTES,
    });
    const stdout = ran.stdout ?? "";
    if (Buffer.byteLength(stdout, "utf8") >= PROVENANCE_TREE_MAX_BYTES) {
      return {
        ok: false,
        why: `the tree listing exceeds the ${PROVENANCE_TREE_MAX_BYTES}-byte ceiling this gate reads`,
      };
    }
    const paths = new Set<string>();
    for (const entry of stdout.split("\0")) {
      if (entry !== "") paths.add(entry);
    }
    return { ok: true, paths };
  } catch (err) {
    return {
      ok: false,
      why: `the tree listing could not be read (${(err as Error).message?.slice(0, 100)})`,
    };
  }
}

/** The production {@link HostRootProbe}: consult the operator's declared root, or say the gate
 * has no root to consult. An unset root is not an unusable one — the claim is simply absent from
 * the host, which is what a record that named nothing outside the commit gets. */
function probeHostRootFromEnv(): HostRootProbe {
  return (fragment: string): HostRootVerdict => {
    const declared = declaredProvenanceRoot();
    if (declared.kind === "unset") return { kind: "absent" };
    if (declared.kind === "invalid") {
      return {
        kind: "unusable",
        why: `${VERIFY_PROVENANCE_ROOT_ENV} is \`${declared.raw.slice(0, 120)}\` and ${declared.why}`,
      };
    }
    return probeHostRoot(declared.raw, fragment);
  };
}

/**
 * Judge one worktree's added data files against its own pinned head.
 *
 * The OID is resolved FIRST and re-used for every read below; an unresolvable HEAD is a
 * named could-not-tell note (never a pass, never a provenance failure), because a gate
 * that cannot say which commit it is judging has no basis for an absence verdict.
 *
 * `prose` selects the arm #2295 added: on, the walk splits a whitespace-bearing value into
 * fragments and judges each, and the key set is the current nine names; off, the walk is the
 * v0.14.85 one — seven names, whole values only. `hostRoot` is the seam that consults the
 * operator's declared root; production passes {@link probeHostRootFor} and a test passes a table.
 * Both are parameters because the two arms are compared against each other by name, and a gate
 * that read both from the environment at every layer could not be driven through one of them.
 */
export async function checkWorktreeProvenance(opts: {
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  cwd: string;
  /** The workstream's effective base — the other end of the added-file range. */
  base: string;
  id: string;
  prose?: boolean;
  hostRoot?: HostRootProbe;
}): Promise<ProvenanceWorkstreamResult> {
  const { execFn, cwd, base, id } = opts;
  const prose = opts.prose ?? verifyProvenanceProseEnabled();
  const hostRoot = opts.hostRoot ?? probeHostRootFromEnv();
  const failures: string[] = [];
  const notes: string[] = [];
  const disclosures: ProvenanceDisclosure[] = [];
  // The one writer of the executed-pass sentence. `judged` is the probe count and this is
  // the only place it is rendered, so a note claiming N probes is the same number the walk
  // counted — there is no second literal for a refactor to buy a green on.
  const judgedLabel = (workstreamId: string): string =>
    `${String(result.judged)} provenance token(s) in workstream "${neutraliseMarkdownField(workstreamId)}" against its pinned commit`;
  const result: ProvenanceWorkstreamResult = {
    failures,
    notes,
    disclosures,
    judged: 0,
    judgedLabel,
  };
  const pinned = await readCommitOid(execFn, cwd, "HEAD", {
    accept: isFullCommitSha,
    timeoutMs: PROVENANCE_GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024,
  });
  if (!pinned.ok) {
    notes.push(
      `${PROVENANCE_NOTE_PREFIX} NOT CHECKED (head of worktree "${id}" could not be resolved to a full commit sha: ${display(pinned.problem)}) — absence was not judged`,
    );
    return result;
  }
  const oid = pinned.oid;
  // The tree listing a bare-basename probe is answered from, read at most once for this
  // workstream. Lazy, because the common record names its files by path and never needs it: a
  // pass that judges only path claims asks exactly the reads the shipped gate asked.
  let treeCache: Promise<{ ok: true; paths: Set<string> } | { ok: false; why: string }> | undefined;
  const treePaths = (): Promise<{ ok: true; paths: Set<string> } | { ok: false; why: string }> => {
    if (treeCache === undefined) treeCache = readTreePaths(execFn, cwd, oid);
    return treeCache;
  };
  const changed = await readCommittedProtectedPaths(execFn, cwd, base, oid, {
    timeout: PROVENANCE_GIT_TIMEOUT_MS,
  });
  if (!changed.ok) {
    // An unreadable diff is not an empty change set: the added files are exactly what this
    // gate judges, so the verdict is "could not tell", never "nothing was added".
    notes.push(
      `${PROVENANCE_NOTE_PREFIX} NOT CHECKED (committed change set of worktree "${id}" is unreadable: ${display(changed.unreadable)})`,
    );
    return result;
  }
  // Added files only, per the binding scope ruling: the `A` records of the committed read,
  // plus a rename/copy whose DESTINATION is a data file git counts as added (`A`), since
  // `changedPaths` projects an `R`/`C` to its destination and a copy-out is exactly the
  // addition a synthesised results file arrives as.
  const added = changedPaths(changed.targets).filter(
    (path, i, all) => all.indexOf(path) === i && isDataFile(path),
  );
  let judged = 0;
  // One budget for the whole workstream, shared by every file it added: the cap is the number
  // of git probes ONE review round pays, and a counter reset per file would make it a per-file
  // allowance and let N files buy N × the cap. The same reasoning puts the dedupe set here —
  // one token cited by two added files is one claim to probe, not two.
  const budget: ProvenanceBudget = { seen: new Set<string>(), chargedInto: 0 };
  let crossFileOverflow = false;
  for (const file of added) {
    const displayFile = display(file);
    const bytes = await readAddedFile(execFn, cwd, oid, file);
    if (!bytes.ok) {
      disclosures.push({ file: displayFile, reason: bytes.why });
      continue;
    }
    if (Buffer.byteLength(bytes.content, "utf8") > PROVENANCE_FILE_MAX_BYTES) {
      disclosures.push({
        file: displayFile,
        reason: `the file is larger than the ${PROVENANCE_FILE_MAX_BYTES}-byte ceiling this gate reads`,
      });
      continue;
    }
    const parsed = tokensOf(
      bytes.content,
      file.toLowerCase().endsWith(NDJSON_SUFFIX),
      budget,
      prose ? PROVENANCE_KEYS : PROVENANCE_KEYS_V0_14_85,
      prose ? proseCandidatesOf : undefined,
    );
    if (!parsed.ok) {
      disclosures.push({ file: displayFile, reason: parsed.why });
      continue;
    }
    // The workstream's running charge, not this file's: the disclosure at the end of the loop
    // fires on the budget the whole workstream has drawn, which is what the constant's own
    // words promise. A per-file counter made the cap a per-file allowance.
    if (parsed.chargedInto > PROVENANCE_MAX_TOKENS) crossFileOverflow = true;
    if (parsed.pastCap) {
      // One row per file, because the rest of the corpus is the thing to say: the walk
      // stopped judging, and a reader must be able to tell "the gate found nothing wrong"
      // from "the gate stopped looking".
      disclosures.push({
        file: displayFile,
        reason: `the file carries more unique provenance tokens than the ${PROVENANCE_MAX_TOKENS} this gate judges for one workstream — the remainder was not judged`,
      });
    }
    for (const { key, shape } of parsed.unjudgable) {
      // One row per key: a value of a shape the rule does not cover is a value nobody judged,
      // and the reader has to be able to tell that from a value that was checked and passed.
      disclosures.push({
        file: displayFile,
        key: display(key),
        reason: `the value under this key is ${shape}, not a path this gate can probe — the claim it makes was not judged`,
      });
    }
    for (const { key, token } of parsed.pairs) {
      const displayKey = display(key);
      const displayToken = display(token);
      // Host context is asked FIRST, before the bare-token classifier. The order is binding:
      // `$S/ops/c5-qual` is host provenance and must be disclosed with the host-provenance
      // reason, not with the classifier's words about a character that needs quoting — a reader
      // who sees "quote" looks for a quoting bug, and a reader who sees "host path" looks at
      // their run directory. A fragment that is not host context then meets the shipped
      // classifier unchanged, which is why a bar-separated value is disclosed rather than probed
      // as its middle word.
      const host = prose ? hostContextProblem(token) : undefined;
      if (host !== undefined) {
        disclosures.push({
          file: displayFile,
          key: displayKey,
          token: displayToken,
          reason: `not a repo-relative path (${host}) — host provenance this gate cannot see`,
        });
        continue;
      }
      const classified = classifyToken(token);
      if (classified.kind === "unverifiable") {
        disclosures.push({
          file: displayFile,
          key: displayKey,
          token: displayToken,
          reason: `not a repo-relative path (${classified.why}) — host provenance this gate cannot see`,
        });
        continue;
      }
      judged++;
      const verdict = await probeCandidate(execFn, cwd, oid, classified.probe, treePaths, prose);
      if (verdict === "unreadable") {
        notes.push(
          `${PROVENANCE_NOTE_PREFIX} could not tell whether ${displayToken} named by ${code(file)}.${displayKey} exists at the pinned commit — not judged`,
        );
        continue;
      }
      if (verdict === "absent") {
        // A claim the commit cannot answer may still be one the project satisfied legitimately:
        // the record's author read the file from a run directory the repository does not track.
        // That is the operator's `PROVENANCE_ROOT` to declare, and consulting it is the ONLY host
        // read this gate makes. A candidate that names a path is looked for at that path under the
        // root; a bare basename is looked for anywhere below it (the root module decides which).
        // An executed `absent` falls through to the failure; an `unusable` root — unreadable, or
        // not an absolute path — is a named could-not-tell note, never a verdict, because a root
        // the gate could not read is not evidence that the file the record cites does not exist.
        const hostVerdict = await hostRoot(classified.probe);
        if (hostVerdict.kind === "present") continue;
        if (hostVerdict.kind === "unusable") {
          notes.push(
            `${PROVENANCE_NOTE_PREFIX} could not tell whether ${displayToken} named by ${code(file)}.${displayKey} exists under the declared ${VERIFY_PROVENANCE_ROOT_ENV} (${display(hostVerdict.why)}) — not judged`,
          );
          continue;
        }
        failures.push(
          `${PROVENANCE_FAILURE_PREFIX} ${code(file)}: ${code(key)} names ${code(token)}, which does not exist in commit ${oid} — a measurement record must cite a source that was committed, not synthesised after the fact`,
        );
      }
    }
    // No separate row for a value that yielded no fragment: the walk offered such a value as a
    // whole-value pair exactly as v0.14.85 did, so the loop above already classified and disclosed
    // it — an extra row here would disclose the same value twice, which a reader cannot tell apart
    // from the record having two distinct claims. The only NEW disclosure this arm adds is a value
    // split past its per-value ceiling, below: its un-probed remainder is genuinely unreported by
    // any other row.
    for (const { key, token } of parsed.truncated) {
      disclosures.push({
        file: displayFile,
        key: display(key),
        token: display(token),
        reason: `the value carries more path-shaped fragments than the ${PROVENANCE_MAX_CANDIDATES_PER_VALUE} this gate probes out of one value — the remainder was not judged`,
      });
    }
  }
  result.judged = judged;
  // The cross-file remainder. `parsed.pastCap` reports the cap binding inside one file, which
  // is right for a file the walk stopped mid-way through; but a workstream whose tokens only
  // overflow when its files are counted TOGETHER overflows the bound the constant advertises,
  // and a reader has to be able to tell "everything was judged" from "the gate ran out of
  // budget". The charge counts every token the workstream offered — probed and unprobeable
  // alike — because an unverifiable token is a token nobody examined and still spent budget.
  if (crossFileOverflow) {
    disclosures.push({
      file: "(the workstream's added data files together)",
      reason: `the workstream carries more unique provenance tokens than the ${PROVENANCE_MAX_TOKENS} this gate judges for one workstream — the remainder was not judged`,
    });
  }
  return result;
}

/**
 * The develop gate's per-worktree provenance pass. Mutates `failures` / `notes` in place
 * and fills the caller's disclosure sink. Runs on EVERY develop verify call and is not
 * eligible for gate reuse: a reused verdict from a pass that skipped this check would be
 * a green for a check that never ran.
 */
export async function runProvenanceGate(opts: {
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  worktrees: Record<string, string>;
  effectiveBaseFor: (wsId: string) => string | undefined;
  failures: string[];
  notes: string[];
  options: VerifyDevelopOutcomeOptions;
}): Promise<void> {
  const { execFn, worktrees, effectiveBaseFor, failures, notes, options } = opts;
  if (!verifyProvenanceEnabled()) {
    notes.push(PROVENANCE_DISABLED_NOTE);
    return;
  }
  const sink = options.provenanceDisclosures;
  if (sink) {
    // Filled in place, as `verifyRecord` is, so a caller holding the array sees the rows.
    sink.disclosures ??= [];
  }
  for (const [id, cwd] of Object.entries(worktrees)) {
    const base = effectiveBaseFor(id);
    if (base === undefined) {
      notes.push(
        `${PROVENANCE_NOTE_PREFIX} NOT CHECKED (no effective base for workstream "${id}") — added data files were not judged`,
      );
      continue;
    }
    const result = await checkWorktreeProvenance({ execFn, cwd, base, id });
    failures.push(...result.failures);
    notes.push(...result.notes);
    if (result.judged > 0) {
      // The executed-pass evidence: which worktree, how many probes. A run that judged
      // nothing says nothing here, so "judged N" is never printed by a run that judged zero
      // — and the workstream is named BEFORE the count so a reader (and the test) sees the
      // clause for the worktree whose probes these are.
      notes.push(`${PROVENANCE_CHECKED_NOTE} ${result.judgedLabel(id)}`);
    }
    if (sink?.disclosures) sink.disclosures.push(...result.disclosures);
  }
}

/**
 * The disclosure section for the PR body. Returns `""` when the run disclosed nothing, so
 * the section is absent rather than empty — the same contract as every sibling section.
 *
 * Only a run that EXECUTED the gate emits disclosures: the caller builds this from the
 * sink the gate filled, never from a state field that could outlive the run.
 */
export function provenanceDisclosureSectionOf(
  disclosures: readonly ProvenanceDisclosure[] | undefined,
): string {
  if (!disclosures || disclosures.length === 0) return "";
  return [
    "",
    "## Data provenance (warning — not blocking)",
    "",
    "The develop gate judged the data files this change adds and could not verify these tokens against the committed tree. The work may well be sound — the gate simply could not see what these values name, so a reviewer should:",
    "",
    ...disclosures.map((d) => {
      const where = d.key === undefined ? `\`${d.file}\`` : `\`${d.file}\` → \`${d.key}\``;
      const named = d.token === undefined ? "" : ` value \`${d.token}\``;
      return `- ${where}${named}: ${d.reason}`;
    }),
  ].join("\n");
}
