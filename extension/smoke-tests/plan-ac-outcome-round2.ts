/**
 * #1855 review round 1 — the round-2 half of the operator-outcome pin, split
 * out of test-plan-ac-outcome.ts at the AGENTS.md §12 500-line cap.
 *
 * PM decision 6, re-pinned at a REAL seam: round 1's draft and the gap gate's
 * corrective re-draft are driven from the SAME parsed `OperatorDirectives`
 * object, and that object is the ONLY thing carrying the operator's outcome —
 * the parallel `operatorOutcomes` parameter is gone from draftSpec, Phase3Args,
 * GateRunArgs and CorrectiveRedraftCtx, so there is no second channel a round
 * could drop. The pin therefore has two halves, and both must be able to fail:
 *
 *   - both bodies render the operator's bullets, and their Acceptance-criteria
 *     sections are byte-identical (the re-draft saw what round 1 saw);
 *   - the identical run with the outcome channel STRIPPED out of the directives
 *     loses the section in BOTH rounds — so handing the re-draft a directives
 *     object without the outcome channel is a red test, not a silently-empty AC
 *     section. `operatorOutcomes` is required on the type, so the only way to
 *     build the stripped object is the explicit overwrite below and tsc refuses
 *     a caller that forgets the field.
 *
 * The helpers it shares with the parent file (assert/section/renders/angle) are
 * passed in, so a failure reports through the parent's counter and exit code.
 */

import { runGate } from "../src/plan-driver-gate.ts";
import { correctiveRedraft } from "../src/plan-driver-redraft.ts";
import type { OperatorDirectives } from "../src/plan-directives.ts";
import type { AngleFindings } from "../src/plan-draft.ts";
import { draftSpec } from "../src/plan-draft.ts";
import { AC_FALLBACK, validateDraft } from "../src/plan-validate.ts";

/** The parent file's assertion sink. */
export type Assert = (cond: boolean, msg: string) => void;
/** Section / bullet helpers shared with the parent so both rounds are judged by
 *  the same renderer view the rest of the file uses. */
export type SectionOf = (body: string, heading: string, next?: string) => string;
export type Renders = (sec: string, item: string) => boolean;

/** The bytes whose re-drafting this pin guards. */
const CTX = "Done when:\n- the tool registers\n- dryRun never files";

export async function runRound2Pin(
  assert: Assert,
  section: SectionOf,
  renders: Renders,
  parseOutcomeDirectives: (context: string) => OperatorDirectives,
): Promise<void> {
  const parsed = parseOutcomeDirectives(CTX);
  assert(
    parsed.operatorOutcomes.length === 2,
    "round 2 fixture: the parser produced the outcome channel",
  );
  const findings: AngleFindings[] = [
    {
      name: "test-surface",
      ok: true,
      text: "test-surface summary",
      toolUses: [{ kind: "edge-case", text: "a pitfall the operator named", angle: "test-surface" }],
    },
  ];
  /** Round 1's draft, from whichever directives the caller passes. */
  const draftFrom = (directives: OperatorDirectives) =>
    draftSpec("feature", "d", findings, [], [], [], 0, directives, []).body;
  /** The gate run driven by those same directives, returning its final body. */
  const gateRun = async (directives: OperatorDirectives) => {
    let title = "";
    let body = draftFrom(directives);
    const run = await runGate({
      dispatch: (async (_pi: unknown, spec: { prompt: string }) => ({
        ok: true,
        // Round 1 is the full GAP DETECTION review and its CRITICAL fires the
        // corrective re-draft; round 2 verifies the carried resolutions.
        text: spec.prompt.includes("SCOPED VERIFICATION")
          ? "VERDICT: READY"
          : "GAP: CRITICAL the criteria do not name the outcome — proposed resolution: the tool registers\nVERDICT: NEEDS_ITERATION",
        toolUses: [],
      })) as never,
      pi: {} as never,
      repoRoot: process.cwd(),
      type: "feature",
      descriptor: "d",
      getBody: () => body,
      setTitleBody: (t, b) => {
        title = t;
        body = b;
      },
      findings,
      inventoryContext: [],
      directives,
      openQuestions: [],
      outOfScope: [],
      depth: 0,
      chosenBudget: { maxItemsPerSection: 20, itemClipChars: 400 },
      priorContext: [],
      settled: [],
      timed: ((_phase: string, fn: () => Promise<unknown>) => fn()) as never,
      correctiveRedraft: correctiveRedraft,
    });
    return { run, title, body };
  };

  const round1 = draftFrom(parsed);
  assert(
    renders(section(round1, "Acceptance criteria", "References"), "the tool registers"),
    "round 1: the draft renders the operator outcome bullets from `directives` alone",
  );

  const { run, title, body } = await gateRun(parsed);
  assert(run.halted === false, "round 2: the gate completed (no re-draft throw)");
  assert(title.length > 0, "round 2: the re-draft set the title (it really ran)");
  const ac = section(body, "Acceptance criteria", "References");
  assert(
    renders(ac, "the tool registers") && renders(ac, "dryRun never files"),
    "#1855 threading: the round-2 body renders the same operator outcome bullets as round 1",
  );
  assert(
    ac === section(round1, "Acceptance criteria", "References"),
    "#1855 one channel: the round-2 AC section is byte-identical to the round-1 one built from the SAME directives",
  );
  assert(
    validateDraft("feature", body, 0, { operatorOmitted: [] }).ok,
    "#1855 threading: the re-drafted body still passes validateDraft",
  );

  // The falsifiable half: a caller that dropped the channel gets the fallback in
  // both rounds, so the channel is proven to be the only carrier rather than one
  // of two equivalent ones.
  const stripped: OperatorDirectives = { ...parsed, operatorOutcomes: [] };
  const strippedRun = await gateRun(stripped);
  const strippedAc = section(strippedRun.body, "Acceptance criteria", "References");
  assert(
    !renders(strippedAc, "the tool registers") &&
      strippedAc.includes(AC_FALLBACK) &&
      draftFrom(stripped).includes(AC_FALLBACK),
    "#1855 pin: directives WITHOUT the outcome channel lose the section in BOTH rounds — `directives` is the only carrier",
  );
}
