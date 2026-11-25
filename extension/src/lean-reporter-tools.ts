/**
 * #2618 — the two lean companion tools' names, spelled ONCE, outside the lean
 * engine.
 *
 * The transport that credits a child's nested (`codemode`) submissions matches a
 * record by its tool NAME, and the lean extractors match a direct call by the
 * same name. So one string lives at three sites: the companion that registers the
 * tool, the extractor that reads the direct call, and the collapse that reads the
 * nested row. Written independently at each, a rename leaves the child calling a
 * name no reader credits — the silent-child bug this issue exists to delete,
 * re-created quietly by a later edit.
 *
 * This module is why they cannot drift. It sits OUTSIDE `extension/src/lean/`
 * because the transport (`spawn-collapse-events.ts`) reports on the lean steps and
 * must not import from the engine it only observes, and lean's own size cap covers
 * that directory. So this file is imported by the transport and by the canary
 * (`smoke-tests/test-lean-reporter-tool-names.ts`), and by NOTHING under
 * `extension/src/lean/`: the two companions and the two extractors keep their own
 * literals, and the canary is what pins those literals to the constants here — it
 * reads each registered/matched name out of the engine's source and feeds a
 * collapsed nested row to the real extractors, so a rename at either side reddens.
 */

/** The specify/challenge child's acceptance-test declaration. */
export const SUBMIT_TESTS_TOOL = "submit_tests";

/** The build child's "these frozen tests cannot all pass together" report. */
export const REPORT_BLOCKED_TOOL = "report_blocked";

/**
 * The WHOLE nested-credit filter. A name outside this set never reaches
 * `DispatchResult.toolUses` as a nested row, which is what keeps the lens and
 * adversarial evidence consumers (the skill-load proof, the unproven-high join)
 * unaffected by construction: a plan child's nested `report_plan_item` is as
 * invisible to them as it always was.
 */
export const CREDITED_NESTED_TOOLS: readonly string[] = [SUBMIT_TESTS_TOOL, REPORT_BLOCKED_TOOL];
