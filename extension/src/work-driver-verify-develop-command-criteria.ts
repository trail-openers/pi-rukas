/**
 * work-driver-verify-develop-command-criteria — the classic `/work` command-criteria tier.
 *
 * A `pi-spec v1` block can carry criteria whose `verify` is `"command"`: text the pipeline
 * is meant to RUN, whose pass condition is green. The lean engine has run that tier since it
 * was written (`lean/verify.ts` step 6). Classic `/work` never had a call site, so a
 * `/work` cycle filed against a spec with command criteria ran none of them and reported the
 * step green — and a project with no discoverable verify command (`verifyCmdFor` finding
 * nothing, the normal shape for a repo in a language the chain does not know) ran no command
 * at all in the develop step.
 *
 * This module MIRRORS that tier by calling the same two functions lean calls —
 * `specCriteriaFor` and `commandCriteriaOutcome` — so one implementation decides what a
 * command criterion is, and the classic wiring neither re-implements nor changes lean's
 * behaviour. It runs **independently of `plan.cmd`**: beside the ratchet and smoke gates, on
 * every develop verify call, and it is not eligible for gate reuse, because a reused verdict
 * from a pass that skipped this tier would be a green for a check that never ran.
 *
 * Four rules decide what reaches `failures`:
 *
 *   1. **A red criterion fails verify.** `commandCriteriaOutcome`'s `failed` is a verdict the
 *      project's own runner observed, so it is the same class of evidence as a red test.
 *   2. **Not-runnable is disclosed, never red.** A criterion the tier refused (its command is
 *      not a plain repo-relative file, its test file moved since base) is the spec's own
 *      defect; reading it as red punishes the developer for a contract they did not write,
 *      and reading it as passed is the lie this tier exists to prevent.
 *   3. **A missing runner template is a named blocking failure.** A spec that carries command
 *      criteria and a project that configured no `verify.test` template cannot be judged at
 *      all, and passing silently is rule 1 inverted. The wording is this module's own
 *      constant: it is not the `[toolchain-unsound]` label and carries none of the markers
 *      `verifyCapFor` routes to another cap, so the outcome stays `verify-failed:develop`.
 *   4. **Anything else the tier could not answer is a note.** An unreadable issue artifact, an
 *      unparsable block, a spec that fails `readiness()`: each is a named could-not-tell note,
 *      never a pass implied by silence and never a failure invented by a machine fault. A tree
 *      that moved under the runs is the one case where rule 1 outranks this one: the run keeps
 *      any red it observed and the note says only that the **green** verdicts lost their
 *      licence. A moved head is a reason to distrust a pass, never a reason to lose a failure
 *      the project's own runner already measured — lean draws the same line by resolving its
 *      red before `recheckAfterRuns` runs.
 *
 * The issue body comes from the driver's cached artifact through `readCachedBody`, never over
 * the network: a develop gate that called `gh issue view` would put a 60-second network read
 * on the critical path of every develop round and let a forge outage decide the verdict.
 *
 * Two decisions that read as gaps and are deliberate, both pinned by
 * `test-work-driver-verify-command-criteria-classic.ts`:
 *
 *   - **A multi-issue cycle is not judged.** The cached artifact holds the PRIMARY issue's
 *     body, so a grouped cycle's siblings' criteria are not in the text this tier reads.
 *     `runCommandCriteriaGate` says so and runs nothing rather than handing every workstream
 *     the primary's contract — a verdict on the wrong spec is worse than no verdict.
 *   - **A criterion's `command` may contain a backslash where the command tier's own
 *     `commandCriterionProblem` refuses one.** `\` is a legal byte in a git path, and this
 *     tier only ever passes a `command` to `runTestFile` as an argv element, so a file
 *     literally named `w\ird.test.ts` exists and runs. The refusal in
 *     `lean/verify-commands.ts` belongs to a tier that hands text to a shell; copying it
 *     here would disclose a real test as unroutable.
 */

import { neutraliseMarkdownField } from "./comment-evidence.ts";
import { loadWorkConfig } from "./lean/config.ts";
import type { Criterion } from "./lean/spec.ts";
import { type CommandCriteriaOutcome, commandCriteriaOutcome } from "./lean/verify-commands.ts";
import { specCriteriaFor } from "./lean/verify-reads.ts";
import { VerifyInfraError } from "./lean/verify-types.ts";
import { readCachedBody } from "./work-develop-scope-fence-seam.ts";
import type { CycleContext } from "./work-driver-context.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { verifyTimeoutMs } from "./work-driver-verify-budget.ts";
import type { VerifyDevelopOutcomeOptions } from "./work-driver-verify-develop-options.ts";
import { verifySwitchOff } from "./work-driver-verify-develop-provenance.ts";
import type { WorkState } from "./workflow-state.ts";

/** The escape hatch; read at call time, off only for the literal `"0"`. */
export const VERIFY_COMMAND_CRITERIA_ENV = "PI_ENSEMBLE_VERIFY_COMMAND_CRITERIA";

/** True unless the operator set {@link VERIFY_COMMAND_CRITERIA_ENV} to exactly `"0"`. */
export function verifyCommandCriteriaEnabled(): boolean {
  return !verifySwitchOff(process.env[VERIFY_COMMAND_CRITERIA_ENV]);
}

/** The note {@link verifyCommandCriteriaEnabled} answers with when the tier is off. */
export const COMMAND_CRITERIA_DISABLED_NOTE =
  "PI_ENSEMBLE_VERIFY_COMMAND_CRITERIA=0 — command-criteria tier disabled";

/** The leading clause every row of this tier carries. */
export const COMMAND_CRITERIA_PREFIX = "command criteria:";

/** The exact fragment `lean/verify-commands.ts` uses for its missing-template refusal. A
 * substring test rather than a sentinel on the thrown error because that module is out of
 * scope here; `test-work-driver-verify-command-criteria-classic.ts` asserts the lean source
 * still contains this text, so the two cannot drift apart in silence. */
const MISSING_TEMPLATE_SIGNATURE = "no verify.test runner template is configured";

/**
 * The blocking failure for a spec that carries command criteria while the project configured
 * no `verify.test` runner template.
 *
 * An exported constant rather than prose at the push site, because the tests and the docs pin
 * this string and a reworded note must not silently reclassify a blocking failure as a note.
 * It carries none of the markers `verifyCapFor` keys on and not the `[toolchain-unsound]`
 * label, so the cap it routes to stays `verify-failed:develop`.
 */
export const MISSING_VERIFY_TEST_TEMPLATE_FAILURE = `${COMMAND_CRITERIA_PREFIX} the issue's spec carries verify:"command" criteria but ${MISSING_TEMPLATE_SIGNATURE} — the criteria cannot be run, so they are not met`;

/** The note that distinguishes an executed pass from a pass that ran nothing: it carries the
 * counts, because "all runnable criteria passed" is also true when none was runnable. */
export const COMMAND_CRITERIA_CHECKED_NOTE_PREFIX = "command criteria: ";

/** What one workstream's run produced. `ran` counts criteria the tier actually executed. */
export interface CommandCriteriaResult {
  failures: string[];
  notes: string[];
  notRunnable: { criterionId: string; reason: string }[];
  ran: number;
}

/** Judge one worktree's command criteria against its own effective base.
 *
 * The OID read first is not a probe ref — this tier's tree reads belong to
 * `commandCriteriaOutcome`, which asks HEAD itself. Its purpose is the ordering check lean
 * applies as `recheckAfterRuns`: the OID is read again after the runs, and a worktree whose
 * HEAD moved under the tier has no verdicts worth keeping, because they were reached against
 * a tree that is gone.
 */
export async function runCommandCriteria(opts: {
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  repoRoot: string;
  cwd: string;
  /** The workstream's effective base, the commit the config and the criteria read at. */
  base: string;
  /** The workstream id, named in every note this run can produce. */
  workstreamId: string;
  /** The issue number, carried to `specCriteriaFor`'s fetcher contract. */
  issue: number;
  /** The cached issue body, or undefined when the cycle has none. */
  body: string | undefined;
  /** Why the body could not be read, when it could not (a named note, never a failure). */
  bodyUnreadable?: string;
  timeoutMs?: number;
}): Promise<CommandCriteriaResult> {
  const { execFn, repoRoot, cwd, base, workstreamId, issue, body, bodyUnreadable, timeoutMs } =
    opts;
  const empty = (notes: string[]): CommandCriteriaResult => ({
    failures: [],
    notes,
    notRunnable: [],
    ran: 0,
  });
  if (bodyUnreadable !== undefined) return empty([notChecked(bodyUnreadable)]);
  if (body === undefined) {
    return empty([
      notChecked("no cached issue body for this cycle — the spec's command criteria were not read"),
    ]);
  }
  const before = await readHeadOid(execFn, cwd);
  if (before === undefined) {
    return empty([
      notChecked(`head of worktree "${workstreamId}" could not be read before the runs`),
    ]);
  }
  let criteria: Criterion[];
  try {
    // The fetcher is the seam `specCriteriaFor` declares; the classic tier hands it the
    // cached body so nothing reaches the network. Its throws are classified below.
    criteria = await specCriteriaFor({ fetchIssueBody: async () => body }, repoRoot, issue);
  } catch (err) {
    return empty([notChecked(`reading the issue's spec: ${whyOf(err)}`)]);
  }
  if (criteria.filter((c) => c.verify === "command").length === 0) {
    // No command criterion is an ordinary run that asked for nothing, not a broken machine.
    return empty([]);
  }
  let template: string | undefined;
  try {
    template = (await loadWorkConfig(execFn as never, repoRoot, base)).verify.test;
  } catch (err) {
    return empty([notChecked(`reading the work config at the effective base: ${whyOf(err)}`)]);
  }
  let outcome: CommandCriteriaOutcome;
  try {
    outcome = await commandCriteriaOutcome(criteria, template, cwd, base, execFn, timeoutMs);
  } catch (err) {
    if (err instanceof VerifyInfraError && err.message.includes(MISSING_TEMPLATE_SIGNATURE)) {
      return {
        failures: [MISSING_VERIFY_TEST_TEMPLATE_FAILURE],
        notes: [],
        notRunnable: [],
        ran: 0,
      };
    }
    return empty([notChecked(`running the command criteria: ${whyOf(err)}`)]);
  }
  // A criterion the tier refuses for the spec's own defect is disclosed here, and is
  // distinguishable from a `VerifyInfraError` ONLY by the type: the lean tier throws for an
  // un-startable or killed runner, and returns a per-criterion reason for a refusal. A
  // wiring that matched on the word "not run" would turn a machine fault into a developer's
  // problem, so this row proves the two channels stay separate.
  const notRunnable = Object.entries(outcome.notRunnable).map(([criterionId, reason]) => ({
    criterionId,
    reason,
  }));
  const ran = Object.keys(outcome.executed).length;
  const after = await readHeadOid(execFn, cwd);
  if (after === undefined || after !== before) {
    // What the runs judged is no longer the worktree's head, so no GREEN from them may be
    // carried: a green is a claim about a tree that is gone. A RED is not that kind of claim.
    // `outcome.failed` is a non-zero exit the project's own runner already observed — evidence
    // against the work — and the move does not make it untrue. Discarding it here would
    // convert a verdict this tier paid for into a pass over notes, which is rule 1 inverted
    // and the false pass a develop child can cause by committing inside the tier's window.
    // So the green verdicts are discarded and the red is carried. Same ordering lean uses,
    // where the red is resolved before `recheckAfterRuns` can hand back at all.
    const failures =
      outcome.failed === undefined ? [] : [`${COMMAND_CRITERIA_PREFIX} ${outcome.failed}`];
    return {
      failures,
      notes: [
        notChecked(
          `the worktree's head moved while the criteria ran (${neutraliseMarkdownField(before)} → ${neutraliseMarkdownField(after ?? "unreadable")}) — the green verdicts were discarded; a red the runner observed is carried`,
        ),
      ],
      notRunnable,
      ran: 0,
    };
  }
  const notes: string[] = [];
  if (outcome.failed !== undefined) {
    return {
      failures: [`${COMMAND_CRITERIA_PREFIX} ${outcome.failed}`],
      notes,
      notRunnable,
      ran,
    };
  }
  if (ran > 0) {
    notes.push(
      `${COMMAND_CRITERIA_CHECKED_NOTE_PREFIX}${String(ran)} of ${String(criteria.length)} command criteria run, none failed`,
    );
  }
  return { failures: [], notes, notRunnable, ran };
}

/** One could-not-tell row. Never a failure: see rule 4 in the module header.
 *
 * Exported because the rows the gate emits below the per-worktree pass (a multi-issue
 * cycle, a workstream with no base) are the same class of answer and must be assertable
 * verbatim: a test that matched them loosely could not tell "the tier refused to judge"
 * from "the tier judged and was unclear". */
export function notChecked(why: string): string {
  return `${COMMAND_CRITERIA_PREFIX} NOT CHECKED (${neutraliseMarkdownField(why)})`;
}

/** The error's own words, clipped and made safe for a note. */
function whyOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 160);
}

/** The OID read this tier's ordering check needs. `readCommitOid` re-throws an executor that
 * could not be called at all (which is how a scripted fake that met an unscripted argv fails
 * loudly); a git that answered and refused is `undefined` — a note, not a verdict. */
async function readHeadOid(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  cwd: string,
): Promise<string | undefined> {
  const ran = await execFn("git", {
    argv: ["rev-parse", "--verify", "HEAD"],
    cwd,
    timeout: 30_000,
    maxBuffer: 8 * 1024,
  }).catch(() => undefined);
  const oid = (ran?.stdout ?? "").trim();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : undefined;
}

/**
 * The develop gate's per-worktree command-criteria pass. Mutates `failures` / `notes` in
 * place. Reads its switch at call time; when off it says so rather than going silent.
 */
export async function runCommandCriteriaGate(opts: {
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  ctx: CycleContext;
  state: WorkState;
  worktrees: Record<string, string>;
  effectiveBaseFor: (wsId: string) => string | undefined;
  failures: string[];
  notes: string[];
  options?: VerifyDevelopOutcomeOptions;
}): Promise<void> {
  const { execFn, ctx, state, worktrees, effectiveBaseFor, failures, notes } = opts;
  if (!verifyCommandCriteriaEnabled()) {
    notes.push(COMMAND_CRITERIA_DISABLED_NOTE);
    return;
  }
  const issues = state.issues ?? [state.issue];
  if (issues.length !== 1) {
    // A grouped cycle has one cached artifact for the PRIMARY issue; judging every
    // workstream against a sibling's contract would be a verdict nobody asked for.
    notes.push(notChecked("a multi-issue cycle has no single spec to judge"));
    return;
  }
  const artifact = state.pipelineState.issueBodyArtifact;
  const body = readCachedBody(ctx.repoRoot, artifact);
  const bodyUnreadable =
    artifact !== undefined && body === undefined
      ? "the cached issue body artifact is missing, unreadable, or outside the cycle's state directory"
      : undefined;
  const timeoutMs = verifyTimeoutMs();
  for (const [id, cwd] of Object.entries(worktrees)) {
    const base = effectiveBaseFor(id);
    if (base === undefined) {
      notes.push(notChecked(`no effective base for workstream "${id}"`));
      continue;
    }
    const result = await runCommandCriteria({
      execFn,
      repoRoot: ctx.repoRoot,
      cwd,
      base,
      workstreamId: id,
      issue: ctx.issue,
      body,
      ...(bodyUnreadable === undefined ? {} : { bodyUnreadable }),
      timeoutMs,
    });
    failures.push(...result.failures);
    notes.push(...result.notes);
    for (const row of result.notRunnable) {
      notes.push(
        `${COMMAND_CRITERIA_PREFIX} criterion ${neutraliseMarkdownField(row.criterionId)} not run: ${neutraliseMarkdownField(row.reason)}`,
      );
    }
  }
}
