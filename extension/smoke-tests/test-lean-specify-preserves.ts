#!/usr/bin/env bun
/**
 * A specify child may freeze a test that states behaviour which must KEEP working.
 *
 * The panel run carried five criteria, four proved red, one written as a behavioural regression test that
 * is green by design. The step refused the run — a child with no move left, three full re-asks burned.
 * These cases pin the smallest change that makes that panel shape complete while every real gap still
 * hands back. Everything runs the REAL `specify` step over a real repo with real commits; only the model is
 * faked (lib/lean-specify-preservation-fixture.ts).
 *
 *   (a) the switch is on by default and only the literal `"0"` turns it off, and its doc row exists;
 *   (b) the panel shape completes: four red files plus one declared-preserved green file freezes all five
 *       criteria, the record names the preserved one, the reason discloses it, and its bytes are the base's;
 *   (c) a green file the child did NOT declare is still the coverage gap it always was;
 *   (d) a row that declares `preserves: true` but writes no file is a missing test, not a preserved one;
 *   (e) a spec whose every test criterion is preserved is refused with its own reason — no contract of
 *       guards alone;
 *   (f) an undeclared green that ALSO breaks the project's own roster is deleted, disclosed, unexcused;
 *   (g) a declared-preserved file that breaks the roster is deleted too — declaring buys no freeze;
 *   (h) with the switch off, the same rows produce the pre-field record and the pre-field prompt and schema,
 *       byte for byte against the capture from the base commit;
 *   (i) a `preserves` value of the wrong type is a malformed call the step skips, never a coercion;
 *   (j) the record's own rules: a list of ids validates, an empty list is refused, and no other step owns it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { neededFromLog } from "../src/lean/handback.ts";
import { outcomeProblem } from "../src/lean/state-outcome.ts";
import type { Step } from "../src/lean/state.ts";
import { leanSpecifyPreservesEnabled } from "../src/lean-specify-preserves-switch.ts";
import { preservedCriteria } from "../src/lean-preserved-step.ts";
import { publishBody } from "../src/lean/publish-body.ts";
import { allPreservedReason } from "../src/specify-preserves.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  CONFIG_WITH_FREEZE_CHECK,
  PANEL_IDS,
  ROSTER_DAMAGE,
  greenFile,
  panelRows,
  redFile,
  runPanel,
  testRel,
} from "./lib/lean-specify-preservation-fixture.ts";
import {
  capturePreservesPanelArm,
  maskPreservesText,
  offArmSchemaText,
  readPreservesFixture,
} from "./lib/lean-specify-preserves-golden.ts";

const { assert, failures } = makeAssert();
/** Run one arm of the switch and hand back whatever the body captured (withEnv itself returns void). */
async function arm<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  let out!: T;
  await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: value }, async () => {
    out = await body();
  });
  return out;
}

const check = (msg: string, cond: boolean, detail?: string): void =>
  assert(cond, msg + (cond || detail === undefined ? "" : `\n    ${detail}`));
const GREEN = "AC5";

/** The step's recorded reason, or the error it threw — every case reads one of the two. */
function said(r: Awaited<ReturnType<typeof runPanel>>): string {
  return String(r.threw?.message ?? r.outcome?.reason ?? "");
}

/** The blob of one path at some commit — what the step actually committed. */
function blobAt(repo: string, sha: string, rel: string): string {
  return execFileSync("git", ["-C", repo, "show", `${sha}:${rel}`], { encoding: "utf8" });
}

/** The commit the step left on the branch — the frozen contract's own tree. */
function headOf(r: Awaited<ReturnType<typeof runPanel>>): string {
  return execFileSync("git", ["-C", r.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

const rowsWith = (
  preservedId?: string,
  patch?: (row: ReturnType<typeof panelRows>[number]) => unknown,
) =>
  panelRows(GREEN, preservedId).map((r) =>
    patch !== undefined && r.id === GREEN ? { ...r, ...patch(r) } : r,
  );

// (a) the switch: on by default, off only for the literal "0", and documented.
await arm(undefined, async () =>
  check("(a) unset means on", leanSpecifyPreservesEnabled() === true),
);
await arm("0", async () =>
  check("(a) only the literal 0 turns it off", leanSpecifyPreservesEnabled() === false),
);
await arm("false", async () =>
  check("(a) any other value leaves it on", leanSpecifyPreservesEnabled() === true),
);
{
  const doc = readFileSync(path.join(import.meta.dir, "../../docs/configuration.md"), "utf8");
  const row = doc.split("\n").find((l) => l.includes("`PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES`"));
  check(
    "(a) the knob is documented with its default",
    row !== undefined && row.includes("| `1` |"),
    String(row),
  );
}

// (b) the panel shape COMPLETES: four red files, one declared-preserved green file.
const panel = await arm(undefined, () => runPanel({ issue: 2668, rows: panelRows(GREEN, GREEN) }));
check("(b) the step froze instead of refusing", panel.threw === undefined, said(panel));
check(
  "(b) the record kind is the ordinary freeze",
  panel.outcome?.kind === "ok",
  String(panel.outcome?.kind),
);
check(
  "(b) the record names the preserved criterion",
  JSON.stringify(panel.outcome?.preserved) === JSON.stringify([GREEN]),
  JSON.stringify(panel.outcome?.preserved),
);
check(
  "(b) all five criteria hold exactly one frozen file",
  PANEL_IDS.every(
    (id) => JSON.stringify(panel.outcome?.tests?.[id]) === JSON.stringify([testRel(id)]),
  ),
  JSON.stringify(panel.outcome?.tests),
);
check(
  "(b) five files were frozen on one child",
  Object.keys(panel.outcome?.frozen ?? {}).length === 5 && panel.dispatched === 1,
  `${Object.keys(panel.outcome?.frozen ?? {}).length} files, ${panel.dispatched} child(ren)`,
);
check(
  "(b) the reason discloses the freeze by name",
  String(panel.outcome?.reason).includes(
    `preserved 1 criterion/criteria (${GREEN}), frozen as must-pass at head`,
  ),
  said(panel),
);
check(
  "(b) the frozen bytes are what the child wrote — the step never edited the preserved file",
  blobAt(panel.repoRoot, headOf(panel), testRel(GREEN)) ===
    readFileSync(path.join(panel.worktree, testRel(GREEN)), "utf8") &&
    blobAt(panel.repoRoot, headOf(panel), testRel(GREEN)) === greenFile(),
);
const declaredButRefused = await arm(undefined, () =>
  // A declared row the boundary refuses (an id the spec does not carry) keeps the RECORD honest: the list
  // names only what the step froze, so no disclosure can claim a freeze the step did not make.
  runPanel({
    issue: 2677,
    rows: panelRows(GREEN, GREEN).map((r) => (r.id === GREEN ? { ...r, id: "AC9" } : r)),
  }),
);
check(
  "(b) a declared criterion the spec does not carry is no exemption",
  declaredButRefused.outcome?.preserved === undefined &&
    said(declaredButRefused).includes(`criterion ${GREEN} has no red test`),
  said(declaredButRefused),
);
const handbackText = neededFromLog([
  {
    state: "specify",
    key: "2668:specify:0",
    outcome: {
      kind: "red-test-gap",
      preserved: [GREEN],
      tests: { [GREEN]: [testRel(GREEN)] },
      reason: `criterion ${GREEN} has no red test; dropped 1: ${GREEN} ${testRel(GREEN)}: exited 0 on base`,
    },
  } as unknown as Step,
]);
check(
  "(b) a handback's own cause names the preserved criterion and its file",
  handbackText.includes(
    `preserved 1: ${GREEN} (${testRel(GREEN)}); each is frozen and must pass at head`,
  ),
  handbackText.slice(-220),
);
const body = publishBody({
  issue: 2668,
  spec: {
    problem: "p",
    size: "S",
    criteria: PANEL_IDS.map((id) => ({ id, text: id, verify: "test" as const })),
  },
  tests: panel.outcome?.tests ?? {},
  draft: false,
  version: "0.0.0",
  models: {},
  baseSha: panel.baseSha,
  preserved: panel.outcome?.preserved,
});
check(
  "(b) the PR body carries its own preserved line",
  body.includes(
    `- preserved: preserved 1: ${GREEN} (${testRel(GREEN)}); each is frozen and must pass at head`,
  ),
  body
    .split("\n")
    .filter((l) => l.includes("preserv"))
    .join(" | ") || "NO PRESERVED LINE",
);

// (c) the SAME shape with no declaration is still the gap.
const undeclared = await arm(undefined, () => runPanel({ issue: 2669, rows: rowsWith(undefined) }));
check(
  "(c) an undeclared green is still refused",
  undeclared.outcome?.kind === "red-test-gap",
  String(undeclared.outcome?.kind),
);
check(
  "(c) naming the criterion the child refused to prove",
  said(undeclared).includes(`criterion ${GREEN} has no red test`),
  said(undeclared),
);
check(
  "(c) and the ordinary gap accounting is untouched",
  undeclared.dispatched === 1,
  String(undeclared.dispatched),
);
check("(c) with no preserved record", undeclared.outcome?.preserved === undefined);

// (d) a row that declares preservation and writes nothing is a MISSING test, not a frozen nothing.
const phantom = await arm(undefined, () =>
  runPanel({
    issue: 2670,
    rows: panelRows(GREEN, GREEN).map((r) => (r.id === GREEN ? { ...r, script: undefined } : r)),
  }),
);
check(
  "(d) a preserved row with no file is still a missing test",
  phantom.outcome?.kind === "red-test-gap",
  said(phantom),
);
check(
  "(d) and the reason is the missing-file rule",
  said(phantom).includes("does not exist in the worktree"),
  said(phantom),
);

// (e) a spec made ENTIRELY of guards has nothing to build, and says so once.
const allPreserved = await arm(undefined, () =>
  runPanel({
    issue: 2671,
    rows: PANEL_IDS.map((id) => ({ id, script: greenFile(), preserves: true })),
  }),
);
check(
  "(e) an all-preserved spec is refused",
  allPreserved.outcome?.kind === "red-test-gap",
  said(allPreserved),
);
check(
  "(e) with its own reason, not 'wrote nothing usable'",
  said(allPreserved).includes("every test criterion is preserved"),
  said(allPreserved),
);
check(
  "(e) the reason is the rule module's own sentence",
  said(allPreserved).startsWith(allPreservedReason(PANEL_IDS)),
  said(allPreserved),
);
check(
  "(e) so it froze nothing and re-asked nobody",
  Object.keys(allPreserved.outcome?.frozen ?? {}).length === 0 && allPreserved.dispatched <= 1,
  String(allPreserved.dispatched),
);
check(
  "(e) and the rule is stable for the same ids",
  allPreservedReason(PANEL_IDS) === allPreservedReason(PANEL_IDS),
);

// (f)+(g) THE ROSTER IS NEVER EXCUSED. A declared criterion that also carries a red file gets that file
// proved, so its row reaches the freeze check; a file the project's own gate cannot stand is deleted and the
// run refused — a declaration buys a freeze for a file the project's tests pass, never for one they break.
/** The green file that trips the project's own gate: red for the candidate, green without it. */
const breaker = (names: string): string =>
  `#!/bin/sh\necho "${names}" 1>&2\necho "${ROSTER_DAMAGE}" 1>&2\nexit 1\n`;
/** Four ordinary reds, plus the criterion carrying both a naming red that breaks the gate and a green. */
const rowsBreakingGate = (preservedId?: string) =>
  PANEL_IDS.filter((id) => id !== GREEN)
    .map((id) => ({ id, script: redFile() }))
    .concat([
      { id: GREEN, script: redFile() },
      {
        id: GREEN,
        script: breaker(`not ok - ${GREEN}-guard.test.sh`),
        rel: `tests/${GREEN}-guard.test.sh`,
        ...(preservedId === GREEN ? { preserves: true } : {}),
      },
    ]);
const brokeUndeclared = await arm(undefined, () =>
  runPanel({ issue: 2672, rows: rowsBreakingGate(undefined), config: CONFIG_WITH_FREEZE_CHECK }),
);
check(
  "(f) a candidate the project's gate cannot stand is refused",
  brokeUndeclared.outcome?.kind === "red-test-gap",
  said(brokeUndeclared),
);
check(
  "(f) and the offender is disclosed by the gate's own words",
  said(brokeUndeclared).includes(ROSTER_DAMAGE),
  said(brokeUndeclared),
);
check(
  "(f) with no criterion excused",
  said(brokeUndeclared).includes(`criterion ${GREEN} has no red test`),
  said(brokeUndeclared),
);
check(
  "(f) and nothing was frozen",
  Object.keys(brokeUndeclared.outcome?.frozen ?? {}).length === 0,
  JSON.stringify(brokeUndeclared.outcome?.frozen),
);
check("(f) with no preserved list", brokeUndeclared.outcome?.preserved === undefined);

const brokeDeclared = await arm(undefined, () =>
  runPanel({ issue: 2673, rows: rowsBreakingGate(GREEN), config: CONFIG_WITH_FREEZE_CHECK }),
);
check(
  "(g) declaring does not excuse the project's own tests",
  brokeDeclared.outcome?.kind === "red-test-gap",
  said(brokeDeclared),
);
check(
  "(g) the criterion is not excused",
  said(brokeDeclared).includes(`criterion ${GREEN} has no red test`),
  said(brokeDeclared),
);
check(
  "(g) its files are absent from the contract",
  brokeDeclared.outcome?.tests?.[GREEN] === undefined,
  JSON.stringify(brokeDeclared.outcome?.tests?.[GREEN]),
);
check(
  "(g) and the offender is disclosed",
  said(brokeDeclared).includes(ROSTER_DAMAGE),
  said(brokeDeclared),
);
check(
  "(g) so a declaration froze nothing",
  brokeDeclared.outcome?.preserved === undefined,
  JSON.stringify(brokeDeclared.outcome?.preserved),
);

// (g2) A declaration may not smuggle a second, green file into the contract for a criterion that already
// has a red one: the row is an ordinary red test, and only the file the proof saw fail is frozen.
const smuggled = await arm(undefined, () =>
  runPanel({
    issue: 2678,
    rows: PANEL_IDS.filter((id) => id !== GREEN)
      .map((id) => ({ id, script: redFile() }))
      .concat([
        { id: GREEN, script: redFile(), preserves: true },
        {
          id: GREEN,
          script: greenFile(),
          rel: `tests/${GREEN}-extra.test.sh`,
          preserves: true,
        },
      ]),
  }),
);
check("(g2) the run still freezes", smuggled.threw === undefined, said(smuggled));
check(
  "(g2) only the file that proved red joined the contract",
  JSON.stringify(smuggled.outcome?.tests?.[GREEN]) === JSON.stringify([testRel(GREEN)]),
  JSON.stringify(smuggled.outcome?.tests?.[GREEN]),
);
check(
  "(g2) the green extra is not in the frozen map",
  Object.keys(smuggled.outcome?.frozen ?? {}).length === 5 &&
    Object.keys(smuggled.outcome?.frozen ?? {}).every((p) => !p.includes("-extra")),
  JSON.stringify(Object.keys(smuggled.outcome?.frozen ?? {})),
);

// (h) the off arm is the pre-field tree, byte for byte.
const fixture = readPreservesFixture();
const PANEL_PANEL_ROWS = PANEL_IDS.map((id) => ({
  id,
  script: id === GREEN ? greenFile() : redFile(),
  ...(id === GREEN ? { preserves: true } : {}),
}));
const offPanel = await arm("0", () => capturePreservesPanelArm(2674, PANEL_PANEL_ROWS));
check(
  "(h) the panel shape is refused again with the switch off",
  offPanel.record.kind === "red-test-gap",
  offPanel.record.kind,
);
check(
  "(h) the off record is the pre-field record of the same panel run",
  JSON.stringify(offPanel.record.outcome) === JSON.stringify(fixture.panel?.outcome),
  JSON.stringify(offPanel.record.outcome),
);
check(
  "(h) the off prompt is the pre-field prompt, byte for byte",
  maskPreservesText(offPanel.prompt) === fixture.prompt,
  `${maskPreservesText(offPanel.prompt).length} vs ${fixture.prompt.length} chars`,
);
const offSchema = await arm("0", () => offArmSchemaText());
check(
  "(h) the off schema is the pre-field schema",
  maskPreservesText(offSchema) === fixture.schema,
  `${maskPreservesText(offSchema).length} vs ${fixture.schema.length} chars`,
);
const onPrompts: string[] = [];
await arm(undefined, () =>
  runPanel({ issue: 2675, rows: panelRows(GREEN, GREEN), prompts: onPrompts }),
);
check(
  "(i) the on prompt carries the declaration clause",
  (onPrompts[0] ?? "").includes("preserves: true"),
  (onPrompts[0] ?? "").slice(-200),
);
check(
  "(i) and the off prompt never mentions the field",
  !offPanel.prompt.includes("preserves: true"),
  offPanel.prompt.slice(-200),
);

// (i) a non-boolean declaration is a malformed call: skipped, never coerced.
const malformed = await arm(undefined, () =>
  runPanel({
    issue: 2676,
    rows: panelRows(GREEN, GREEN).map((r) => (r.id === GREEN ? { ...r, preserves: "yes" } : r)),
  }),
);
check(
  "(i) a non-boolean preserves freezes nothing",
  malformed.outcome?.kind === "red-test-gap",
  said(malformed),
);
check(
  "(i) the call is counted as malformed",
  said(malformed).includes("malformed"),
  said(malformed),
);
check("(i) no criterion was excused by it", malformed.outcome?.preserved === undefined);

// (j) the record's own rules.
check(
  "(j) a list of ids validates",
  outcomeProblem({ kind: "done", preserved: ["AC1", "AC3"] }, "specify") === undefined,
);
check(
  "(j) an empty list is refused, so absence and emptiness read apart",
  outcomeProblem({ kind: "done", preserved: [] }, "specify") !== undefined,
);
check(
  "(j) a non-AC id is refused",
  outcomeProblem({ kind: "done", preserved: ["x"] }, "specify") !== undefined,
);
check(
  "(j) no other step may carry it",
  outcomeProblem({ kind: "done", preserved: ["AC1"] }, "verify") !== undefined,
);
check(
  "(j) the rule reads declared rows only",
  JSON.stringify(
    preservedCriteria([{ criterionId: "AC1", preserves: true }, { criterionId: "AC2" }]),
  ) === JSON.stringify(["AC1"]),
);

process.exit(failures());
