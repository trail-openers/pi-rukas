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
import { classifyToken, code, display } from "./work-driver-verify-develop-provenance-token.ts";
import { tokensOf } from "./work-driver-verify-develop-provenance-walk.ts";

/** The escape hatch; read at call time, off only for the literal `"0"`. */
export const VERIFY_PROVENANCE_ENV = "PI_ENSEMBLE_VERIFY_PROVENANCE";

/** True unless the operator set {@link VERIFY_PROVENANCE_ENV} to exactly `"0"`. */
export function verifyProvenanceEnabled(): boolean {
  return !verifySwitchOff(process.env[VERIFY_PROVENANCE_ENV]);
}

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
 * The keys whose string values are read as provenance, at any nesting depth.
 *
 * ONE constant, because the field case this gate exists for is a generator that renames
 * the key: a set that lived in config would be a set a child could widen. A key missing
 * here is a gap in this list, not a format the gate failed to detect.
 */
export const PROVENANCE_KEYS: readonly string[] = [
  "source",
  "sourceFile",
  "sourcePath",
  "sources",
  "input",
  "inputFile",
  "resultsFile",
];

/** Extensions whose bytes are read as JSON / NDJSON. YAML and every other format is out
 * of scope: an added file with any other extension is simply not a data record here. */
const DATA_SUFFIXES = [".json", ".ndjson"] as const;

/** A file whose own text is a JSON array of rows, one record per line. */
const NDJSON_SUFFIX = ".ndjson";

/** The wall clock on this module's own git reads (the OID pin and the added-file range). */
export const PROVENANCE_GIT_TIMEOUT_MS = 30_000;
/** Byte ceiling on each of those reads: a ref is one line, a name-status list is not. */
export const PROVENANCE_GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** Byte ceiling on one added data file. Past it the file is disclosed, never judged. */
export const PROVENANCE_FILE_MAX_BYTES = 1024 * 1024;
/** Unique tokens judged per workstream. Past it the rest is disclosed, never judged. */
export const PROVENANCE_MAX_TOKENS = 256;

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

/** Does this added path name a file this gate reads as a data record? */
function isDataFile(p: string): boolean {
  const lower = p.toLowerCase();
  return DATA_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

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

/**
 * Judge one worktree's added data files against its own pinned head.
 *
 * The OID is resolved FIRST and re-used for every read below; an unresolvable HEAD is a
 * named could-not-tell note (never a pass, never a provenance failure), because a gate
 * that cannot say which commit it is judging has no basis for an absence verdict.
 */
export async function checkWorktreeProvenance(opts: {
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  cwd: string;
  /** The workstream's effective base — the other end of the added-file range. */
  base: string;
  id: string;
}): Promise<ProvenanceWorkstreamResult> {
  const { execFn, cwd, base, id } = opts;
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
    const parsed = tokensOf(bytes.content, file.toLowerCase().endsWith(NDJSON_SUFFIX));
    if (!parsed.ok) {
      disclosures.push({ file: displayFile, reason: parsed.why });
      continue;
    }
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
      const verdict = await probeToken(execFn, cwd, oid, classified.probe);
      if (verdict === "unreadable") {
        notes.push(
          `${PROVENANCE_NOTE_PREFIX} could not tell whether ${displayToken} named by ${code(file)}.${displayKey} exists at the pinned commit — not judged`,
        );
        continue;
      }
      if (verdict === "absent") {
        failures.push(
          `${PROVENANCE_FAILURE_PREFIX} ${code(file)}: ${code(key)} names ${code(token)}, which does not exist in commit ${oid} — a measurement record must cite a source that was committed, not synthesised after the fact`,
        );
      }
    }
  }
  result.judged = judged;
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
