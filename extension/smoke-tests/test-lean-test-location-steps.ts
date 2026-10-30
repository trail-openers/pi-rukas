#!/usr/bin/env bun
/**
 * lean — the configured test location, END TO END (`verify.testDir` + `testGlob`).
 *
 * The companion of `test-lean-test-location.ts`, which pins the pure rules. This
 * file drives the real steps against real temp git repos, so "refused" here
 * means the file was never frozen and never committed, and "told" means the
 * prompt string the STEP built said it — not that a helper returned a string.
 *
 *   (3a) the boundary (`validateSubmitRows`): a submitted test outside the folder,
 *        in a NESTED folder, or under a name the pattern rejects, is dropped with
 *        a reason; a `./` or backslash spelling of a good path is not a dodge; and
 *        with no config at all none of these rules fire. The order the rules answer
 *        in is pinned too, because the reason an operator reads is whichever rule
 *        fired first.
 *   (3b) `specify`: a well-placed red test freezes; a misplaced one, and a
 *        right-folder/wrong-name one, each end the run as `no-red-test` naming the
 *        uncovered criterion, freeze nothing, and leave the worktree at its base —
 *        and the dispatched prompt carried the folder, so the child is policed by
 *        a rule it was actually told.
 *   (3c) `challenge`: the same boundary on the edge-case round. A misplaced edge
 *        case earns `none` with the LOCATION in its reason (never "the builder
 *        handles this"), a well-placed green one is still dropped for being green,
 *        and a contract frozen OUTSIDE the configured folder before the setting
 *        existed does not break the round — the rule governs what the adversary
 *        submits, never what the run already holds.
 *
 * Shared fixture: lib/lean-test-location-fixture.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChallengeInfraError } from "../src/lean/challenge.ts";
import { validateSubmitRows } from "../src/lean/specify-tree.ts";
import {
  challengeFixture,
  greenEdge,
  put,
  redEdge,
  runChallenge,
} from "./lib/lean-challenge-fixture.ts";
import {
  ROOTS,
  SpecifyInfraError,
  git,
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";
import {
  assert,
  LOC,
  SPEC,
  configWithLocation,
  testLocationExit,
} from "./lib/lean-test-location-fixture.ts";

// ────────────────────────────────── (3a) the boundary refuses misplaced tests

/**
 * A temp worktree for the boundary calls that judge nothing but placement.
 *
 * `wt` is a required argument — the size rules read the candidate out of a real
 * tree, and a rule that goes quiet when its argument is missing is a rule a
 * caller can forget. These cases are about WHERE a file sits, so they hand the
 * boundary a real (empty) tree and say `sizeRules: false`: no stat, no read, and
 * every other rule — the quota included — judged exactly as production judges it.
 */
function emptyWt(label: string): string {
  const dir = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/pi-lean-loc-${label}-`);
  ROOTS.push(dir);
  return dir;
}

{
  const present = new Set([
    "extension/smoke-tests/test-ac1.ts",
    "extension/smoke-tests/unit/test-nested.ts",
    "tests/test-wrong-dir.ts",
    "extension/smoke-tests/spec-wrong-name.ts",
  ]);
  const { kept, dropped } = await validateSubmitRows(
    [
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/test-ac1.ts"] },
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/unit/test-nested.ts"] },
      { criterionId: "AC1", testFiles: ["tests/test-wrong-dir.ts"] },
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/spec-wrong-name.ts"] },
      // The same good file, spelled with a `./` and a `\`: normalisation runs
      // BEFORE the location check, so a dodge by punctuation is not a dodge.
      { criterionId: "AC1", testFiles: ["./extension/smoke-tests/test-ac1.ts"] },
      { criterionId: "AC1", testFiles: ["extension\\smoke-tests\\test-ac1.ts"] },
    ],
    {
      spec: SPEC,
      exists: (p) => present.has(p),
      testLocation: LOC,
      wt: emptyWt("placed"),
      sizeRules: false,
    },
  );
  assert(
    kept.length === 1 && kept[0]?.testFiles.join() === "extension/smoke-tests/test-ac1.ts",
    `only the correctly placed and named test survives (got ${JSON.stringify(kept)})`,
  );
  const reasons = dropped.map((d) => `${d.path}|${d.reason}`);
  assert(
    dropped.some(
      (d) =>
        d.path === "extension/smoke-tests/unit/test-nested.ts" &&
        d.reason.includes("not directly inside"),
    ) && reasons.some((r) => r.startsWith("tests/test-wrong-dir.ts|")),
    "a nested folder is refused with a reason naming the folder rule",
  );
  assert(
    dropped.some((d) => d.path === "tests/test-wrong-dir.ts" && d.reason.includes("testDir")),
    "a file in the wrong directory is refused naming verify.testDir",
  );
  assert(
    dropped.some(
      (d) => d.path === "extension/smoke-tests/spec-wrong-name.ts" && d.reason.includes("testGlob"),
    ),
    "a file with the wrong name is refused naming verify.testGlob",
  );
  assert(
    dropped.filter((d) => d.path === "./extension/smoke-tests/test-ac1.ts").length === 0 &&
      dropped.filter((d) => d.path === "extension\\smoke-tests\\test-ac1.ts").length === 0,
    "a `./` or `\\` spelling of the good path normalises to the kept file, not a refusal",
  );
  // Without the config, all four paths are judged only by the pre-existing rules
  // — the feature must not fire when unset.
  const unconfigured = await validateSubmitRows(
    [
      { criterionId: "AC1", testFiles: ["tests/test-wrong-dir.ts"] },
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/spec-wrong-name.ts"] },
    ],
    { spec: SPEC, exists: (p) => present.has(p), wt: emptyWt("unconfigured"), sizeRules: false },
  );
  assert(
    unconfigured.kept.length === 1 && unconfigured.dropped.length === 0,
    `no config → both files judged only by the existing rules (kept ${unconfigured.kept.length}, dropped ${unconfigured.dropped.length})`,
  );
}

/**
 * Which boundary rule answers first, pinned directly. `validateSubmitRows` asks
 * in a fixed order — path shape, then "already frozen", then the configured
 * location, then existence — and the reason an operator reads is whichever rule
 * fired. Three arms, because an E2E run only ever reports the one that fired:
 *
 *   - a path that is BOTH misplaced and frozen reports FROZEN, and never
 *     "misplaced": that reading would tell an operator to MOVE a file the run
 *     must not touch, and the inherited contract of a project that adopted
 *     `verify.testDir` after its first freeze is exactly this shape;
 *   - a path that is well placed but already frozen reports FROZEN too;
 *   - a path that is well placed, not frozen, and never written reports
 *     EXISTENCE — the location rule did not swallow it.
 */
{
  const ordered = await validateSubmitRows(
    [
      { criterionId: "AC1", testFiles: ["tests/AC1-retry.test.sh"] },
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/test-ac1.ts"] },
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/test-ac2-missing.ts"] },
    ],
    {
      spec: SPEC,
      exists: (p) => p === "extension/smoke-tests/test-ac1.ts",
      testLocation: LOC,
      wt: emptyWt("ordered"),
      sizeRules: false,
      frozenPaths: new Set(["tests/AC1-retry.test.sh", "extension/smoke-tests/test-ac1.ts"]),
    },
  );
  const reasonFor = (rel: string): string =>
    ordered.dropped.find((d) => d.path === rel)?.reason ?? "";
  assert(
    ordered.kept.length === 0,
    `nothing survives when every path is frozen or unwritten (got ${JSON.stringify(ordered.kept)})`,
  );
  assert(
    reasonFor("tests/AC1-retry.test.sh").includes("frozen acceptance test") &&
      reasonFor("tests/AC1-retry.test.sh").includes("not directly inside") === false,
    `a MISPLACED path that the run already froze reports FROZEN, never the location rule that would tell the operator to move it (got ${reasonFor("tests/AC1-retry.test.sh")})`,
  );
  assert(
    reasonFor("extension/smoke-tests/test-ac1.ts").includes("frozen acceptance test") &&
      reasonFor("extension/smoke-tests/test-ac1.ts").includes("not directly inside") === false,
    `a well-placed frozen path reports FROZEN and never "misplaced" (got ${reasonFor("extension/smoke-tests/test-ac1.ts")})`,
  );
  assert(
    reasonFor("extension/smoke-tests/test-ac2-missing.ts").includes("does not exist"),
    `a well-placed file the child never wrote reports EXISTENCE (got ${reasonFor("extension/smoke-tests/test-ac2-missing.ts")})`,
  );
}

// ───────────────────────── (3b) specify end-to-end: a misplaced test is refused

{
  const good = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const r = await runSpecify({
    repoRoot: good.repoRoot,
    baseSha: good.baseSha,
    issue: 1883,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: (wt) => {
      mkdirSync(path.join(wt, "extension/smoke-tests"), { recursive: true });
      writeFileSync(path.join(wt, "extension/smoke-tests/test-ac1-retry.ts"), redScript(), {
        mode: 0o755,
      });
    },
    toolUses: [submit("AC1", ["extension/smoke-tests/test-ac1-retry.ts"])],
  });
  assert(r.threw === undefined, `(specify) correctly placed test: no throw (${r.threw?.message})`);
  assert(
    r.outcome?.kind === "ok" &&
      Object.keys(r.outcome.frozen ?? {}).join() === "extension/smoke-tests/test-ac1-retry.ts",
    `(specify) the test in the configured folder freezes (got ${JSON.stringify(r.outcome)})`,
  );

  // Same repo, same red test, one directory off: the criterion goes uncovered
  // and nothing is frozen — the same refusal an invalid path earns. A run that
  // froze it anyway would hand the project a test its own CI never runs.
  const bad = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const refused = await runSpecify({
    repoRoot: bad.repoRoot,
    baseSha: bad.baseSha,
    issue: 1884,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/test-ac1-retry.ts"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/test-ac1-retry.ts"])],
  });
  assert(
    refused.threw === undefined,
    `(specify) a misplaced test is a VERDICT, not infra (${refused.threw?.message})`,
  );
  assert(
    refused.outcome?.kind === "no-red-test",
    `(specify) misplaced test → no-red-test (got ${refused.outcome?.kind})`,
  );
  assert(
    refused.outcome?.kind === "no-red-test" &&
      refused.outcome.failedRules?.[0]?.startsWith("criterion AC1 has no red test") === true,
    `(specify) the rule still leads with the uncovered criterion (got ${JSON.stringify(refused.outcome?.failedRules)})`,
  );
  assert(
    (refused.outcome?.reason ?? "").includes("not directly inside the configured test directory"),
    `(specify) the reason says WHY the file was refused (got ${refused.outcome?.reason})`,
  );
  assert(
    git(refused.worktree, "rev-list", "--count", "HEAD").trim() === "1",
    `(specify) a refused round commits nothing — the tree still holds only its base (got ${git(refused.worktree, "rev-list", "--count", "HEAD")})`,
  );

  // The wrong NAME, in the right folder: same refusal, different reason.
  const wrongName = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const named = await runSpecify({
    repoRoot: wrongName.repoRoot,
    baseSha: wrongName.baseSha,
    issue: 1885,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: (wt) => {
      mkdirSync(path.join(wt, "extension/smoke-tests"), { recursive: true });
      writeFileSync(path.join(wt, "extension/smoke-tests/spec-ac1-retry.ts"), redScript(), {
        mode: 0o755,
      });
    },
    toolUses: [submit("AC1", ["extension/smoke-tests/spec-ac1-retry.ts"])],
  });
  assert(
    named.outcome?.kind === "no-red-test" &&
      (named.outcome.reason ?? "").includes("does not match the configured test name pattern"),
    `(specify) a right-folder/wrong-name test is refused naming the pattern (got ${named.outcome?.kind} / ${named.outcome?.reason})`,
  );

  // And the prompt the step actually sent named the folder — the config is not
  // enforced silently while the child is still told to write anywhere.
  const prompts: string[] = [];
  const told = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  await runSpecify({
    repoRoot: told.repoRoot,
    baseSha: told.baseSha,
    issue: 1886,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: () => {},
    toolUses: [],
    prompts,
  });
  assert(
    prompts.length === 1 &&
      prompts[0]?.includes("directly inside `extension/smoke-tests/`") === true,
    "(specify) the dispatched prompt carried the configured folder",
  );
  assert(ROOTS.length > 0, "the temp repos this case created are registered for cleanup");
}

// ─────────────────────────── (3c) challenge end-to-end: the same boundary holds

{
  const EDGE_DIR = "extension/smoke-tests";
  const EDGE = `${EDGE_DIR}/test-ac1-edge-second-failure.ts`;
  const r = await runChallenge({
    issue: 201,
    config: configWithLocation(EDGE_DIR, "test-*.ts"),
    child: (wt) => put(wt, EDGE, redEdge(EDGE), 0o755),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(r.threw === undefined, `(challenge) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "new-tests" && Object.keys(r.outcome.frozen ?? {}).join() === EDGE,
    `(challenge) an edge case in the configured folder freezes (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    r.prompts[0]?.includes("directly inside `extension/smoke-tests/`") === true,
    "(challenge) the adversary was TOLD the folder, not just policed by it",
  );

  // A misplaced edge case earns `none` — the round found nothing the step may
  // freeze — and the reason says the file was refused for its location, so it
  // is never mistaken for "the builder handles this case".
  const off = await runChallenge({
    issue: 202,
    config: configWithLocation(EDGE_DIR, "test-*.ts"),
    child: (wt) => put(wt, "tests/test-ac1-edge.ts", redEdge("tests/test-ac1-edge.ts"), 0o755),
    toolUses: [submit("AC1", ["tests/test-ac1-edge.ts"])],
  });
  assert(
    off.threw === undefined,
    `(challenge) misplaced edge case is a verdict (${off.threw?.message})`,
  );
  assert(
    off.outcome?.kind === "none",
    `(challenge) a misplaced edge case freezes nothing → none (got ${off.outcome?.kind})`,
  );
  assert(
    (off.outcome?.reason ?? "").includes("not directly inside the configured test directory"),
    `(challenge) the reason names the location rule, not "already handled" (got ${off.outcome?.reason})`,
  );
  assert(
    off.outcome?.kind === "none" && off.dispatched === 1,
    "(challenge) the adversary was paid once and the round simply found nothing freezable",
  );

  // The frozen contract this fixture committed lives OUTSIDE the configured
  // folder (`tests/AC1-retry.test.sh`), and the run must still start: the rule
  // governs what the adversary SUBMITS, it never retroactively refuses the
  // contract the run inherited — `assertFrozenIntact` has to keep reading that
  // blob at the head, or a project adopting the setting would break its own
  // in-flight runs.
  const legacy = await runChallenge({
    issue: 203,
    config: configWithLocation(EDGE_DIR, "test-*.ts"),
    child: (wt) => put(wt, EDGE, redEdge(EDGE), 0o755),
    toolUses: [
      submit("AC1", [EDGE]),
      submit("AC1", ["tests/AC1-retry.test.sh", "extension/smoke-tests/test-ac1-misplaced.ts"]),
    ],
    built: challengeFixture(203),
  });
  assert(
    legacy.outcome?.kind === "new-tests" &&
      Object.keys(legacy.outcome.frozen ?? {}).join() === EDGE,
    `(challenge) a pre-existing frozen test outside the folder does not break the round (got ${JSON.stringify(legacy.outcome?.frozen)})`,
  );
  // The two refusals each carry their OWN reason: the frozen path is refused
  // because the run already froze it (the contract predates the setting), and
  // the new file is refused for never having been written. A third spelling — a
  // frozen path in the RIGHT folder — is pinned in (3a) below, so the frozen
  // rule's precedence over the location rule is proven rather than assumed.
  assert(
    legacy.outcome?.kind === "new-tests" &&
      (legacy.outcome.reason ?? "").includes("does not exist") &&
      (legacy.outcome.reason ?? "").includes("test-ac1-misplaced.ts"),
    `(challenge) one round reports a not-written refusal and the inherited contract stays intact (got ${legacy.outcome?.reason})`,
  );
  const frozenInPlace = await validateSubmitRows(
    [{ criterionId: "AC1", testFiles: ["extension/smoke-tests/test-ac1.ts"] }],
    {
      spec: SPEC,
      exists: () => true,
      testLocation: LOC,
      wt: emptyWt("frozen-in-place"),
      sizeRules: false,
      frozenPaths: new Set(["extension/smoke-tests/test-ac1.ts"]),
    },
  );
  assert(
    frozenInPlace.kept.length === 0 &&
      frozenInPlace.dropped[0]?.reason.includes("frozen acceptance test") === true &&
      frozenInPlace.dropped[0]?.reason.includes("misplaced") === false &&
      frozenInPlace.dropped[0]?.reason.includes("not directly inside") === false,
    `a frozen path that sits INSIDE the configured folder is refused as frozen, never as misplaced (got ${frozenInPlace.dropped[0]?.reason})`,
  );

  // A frozen path must outrank the BASE-NEWNESS rule too, and this is the one
  // shape where the two are not the same answer: an inherited frozen test is
  // present at the base AND in the frozen set, so a swapped order would report
  // it as "not a new file" — which tells the adversary to pick another name for
  // a file the run forbids it to touch at all.
  const frozenAtBase = await validateSubmitRows(
    [{ criterionId: "AC1", testFiles: ["tests/AC1-retry.test.sh"] }],
    {
      spec: SPEC,
      exists: () => true,
      existsAtBase: async () => true,
      wt: emptyWt("frozen-at-base"),
      sizeRules: false,
      frozenPaths: new Set(["tests/AC1-retry.test.sh"]),
    },
  );
  assert(
    frozenAtBase.kept.length === 0 &&
      frozenAtBase.dropped[0]?.reason.includes("frozen acceptance test") === true &&
      frozenAtBase.dropped[0]?.reason.includes("base commit") === false,
    `an inherited frozen test keeps the FROZEN reason and never gets the newness one (got ${frozenAtBase.dropped[0]?.reason})`,
  );

  // A green edge case in the RIGHT place is still dropped for being green —
  // the location rule must not have become the only rule the boundary applies.
  const green = await runChallenge({
    issue: 204,
    config: configWithLocation(EDGE_DIR, "test-*.ts"),
    child: (wt) =>
      put(wt, `${EDGE_DIR}/test-ac1-green.ts`, greenEdge(`${EDGE_DIR}/test-ac1-green.ts`), 0o755),
    toolUses: [submit("AC1", [`${EDGE_DIR}/test-ac1-green.ts`])],
  });
  assert(
    green.outcome?.kind === "none" && (green.outcome.reason ?? "").includes("exited 0 on base"),
    `(challenge) a well-placed GREEN test is dropped for being green, not for its path (got ${green.outcome?.reason})`,
  );
  // A misplaced test is a VERDICT. Asserting that is only meaningful against the
  // throw the assertion would have accepted — the infra class — so the check is
  // on the thrown value itself, not on `typeof Class === "function"`, which is
  // true whatever the step did.
  assert(
    green.threw === undefined,
    `(challenge) a misplaced/misjudged round is a VERDICT, not infra (${green.threw?.constructor?.name}: ${green.threw?.message})`,
  );
  assert(
    green.threw === undefined || !(green.threw instanceof ChallengeInfraError),
    `(challenge) the well-placed round raised no infra error (got ${green.threw?.constructor?.name})`,
  );
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(
  testLocationExit() === 0 ? "\nConfigured test location is enforced end to end." : "\nFAILED",
);
process.exit(testLocationExit());
