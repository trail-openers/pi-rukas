#!/usr/bin/env bun
/**
 * LIVE: a STRICT-shaped child loads both entry points and still has ONE
 * `forge_read` (#2382).
 *
 * The outage this pins: under Pi 1.5.2 every strict/headless child died before
 * its session attached. `buildChildArgs` gives such a child BOTH
 * `--extension <repo>/extension` and `--extension <repo>/extension/src/child-guards.ts`,
 * and BOTH called `registerChildForgeReadTool`, so Pi 1.5.2's
 * `detectExtensionConflicts` reported a duplicate tool and `main.js` exited 1:
 *
 *   Error: Failed to load extension "<repo>/extension": Tool "forge_read"
 *   conflicts with <repo>/extension/src/child-guards.ts
 *
 * Pi 1.4.0 tolerated the duplicate and nothing tested the "Pi de-duplicates by
 * name" claim both registration sites asserted — which is why the offline suites
 * stayed green through the bump. `pi-rukas-headless plan` therefore died at exit
 * 40 (ALL-ANGLES-FAILED) and headless `/work` had no working children.
 *
 * Why this is a live test and not only the offline one:
 * `test-child-forge-read-single-owner.ts` counts registrations into one fake
 * API, which pins the ONE-OWNER contract but cannot show that a real pi process
 * accepts the argv — 1.5.2's check runs in Pi's own loader, before our code can
 * observe it. This file dispatches one `explore` child through the shipped
 * spawn path with `workCycleTrust` left OFF, which is precisely the shape that
 * forwards the full extension beside the companion (`planChildPermissions`
 * enables the subagent guard, so `subagentGuardEnabled` is true and
 * `piEnsembleExtensionPath()` lands in the argv). A skip is never a pass: an
 * arms-without-spawn run fails.
 *
 *   cd extension && bun run smoke-tests/test-strict-child-forge-read-live.ts
 *
 * The RED half: `lib/forge-read-duplicate-mutant.ts` restores the pre-#2382
 * shape (both child entry points calling `registerChildForgeReadTool` beside the
 * companion's own). The offline `test-child-forge-read-single-owner.ts` §5 loads
 * that pair through the shipped registration and must count 2 where the shipped
 * code counts 1; loaded into a REAL child through Pi's loader the same pair
 * reproduces this file's exit-1 load error, which is why the live rows below
 * assert a clean load and one broker read rather than trusting the comment.
 *
 * `test-reviewer-scratch-home-live.ts` sets `workCycleTrust: true` and is NOT
 * this test's substitute: that field is what the `/work` driver sets on its own
 * dispatches, and it makes the child a TRUST child, which forwards no full
 * extension at all — so that harness never loads both entry points and never
 * reaches the conflict. Its comment names the conflict as the reason. Do not
 * "widen" that file to strict; this file is the strict half.
 */

import { ROLES } from "../src/roles.ts";
import { spawnSpecialist } from "../src/spawn.ts";
import { assert, exit } from "./lib/assert-rig.ts";

// Deliberately live: the offline anti-leak guard would refuse this spawn.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";
// The strict shape is the subject. A harness that happened to inherit either
// variable would plan a trust child and forward no full extension — the test
// would then pass without ever loading the two entry points together.
delete process.env.PI_ENSEMBLE_TRUST_MODE;
delete process.env.PI_ENSEMBLE_SANDBOX_MODE;
// Same stale-broker-dir cleanup as the reviewer scratch-home live harness: an
// inherited `GH_CONFIG_DIR` can name a per-child dir an earlier spawn already
// removed, which makes the PARENT-side read fail for a reason that is this
// harness's artefact, not the child's condition.
if (
  process.env.GH_CONFIG_DIR &&
  !(await Bun.file(`${process.env.GH_CONFIG_DIR}/hosts.yml`).exists())
) {
  console.log(`[test] dropping stale GH_CONFIG_DIR=${process.env.GH_CONFIG_DIR}`);
  delete process.env.GH_CONFIG_DIR;
}

const issueNumber = process.env.PI_ENSEMBLE_LIVE_ISSUE ?? "2382";

// The role prompt is read from `dist/prompts/standard/` by `spawnSpecialist`, and
// that directory is gitignored — a worktree that has not been built has no prompt
// to read, and the child would fail for a reason that is this harness's state, not
// the code's. Judge it as a row (so the failure is visible in the tally) and stop
// before the spawn, naming the fix.
const promptBuilt = await Bun.file(ROLES.explore.promptFile).exists();
assert(
  promptBuilt,
  `the explore role prompt exists at ${ROLES.explore.promptFile} — run \`bun run build\` from the repo root before this live test`,
);
if (!promptBuilt) {
  console.error("✗ cannot dispatch: the prompt layer is not built");
  process.exit(1);
}

// ── One strict-shaped explore child: loads, answers, reads the forge once ───
// `workCycleTrust` is deliberately absent from the opts below: without it, and
// outside a parent session, `planChildPermissions` plans STRICT, which is the
// shape that carries both `--extension` flags.
console.log(`\n[test] strict dispatch of one explore child (issue #${issueNumber})`);
const r = await spawnSpecialist(
  {
    role: "explore",
    prompt: [
      "Deterministic probe. Follow EXACTLY, one tool call per step:",
      `1. Call the \`forge_read\` tool EXACTLY ONCE with verb "issue_view" and number ${issueNumber}. You MUST make this tool call before replying; replying without it fails the probe.`,
      "2. Then reply with exactly three lines:",
      `   FORGE <the issue's number you saw, or NOFORGE if step 1 failed>`,
      "   TITLE <the first 40 characters of the issue title>",
      "   DONE",
      "Do not use any other tool. Do not write files. Do not use vipune.",
    ].join("\n"),
  },
  { timeoutMs: 240_000 },
);
const report = `${r.text}\n${r.errorStop?.message ?? ""}`;
console.log(
  `[test] ok=${r.ok} exit=${r.exitCode} ms=${r.ms} model=${r.model ?? "(none)"} tools=${r.toolUses?.length ?? 0}`,
);
console.log(`[test] reply=${JSON.stringify(r.text.slice(0, 200))}`);

// The load itself: Pi 1.5.2 reports the duplicate as a load error and exits 1,
// so this row is the defect's own tell.
assert(
  !/Failed to load extension|conflicts with/i.test(report),
  `the strict child loaded (no duplicate-tool load error: ${JSON.stringify(report.slice(0, 160))})`,
);
assert(r.model !== undefined, "the strict child resolved a model");
assert(!r.errorStop, `no provider errorStop (${r.errorStop?.message ?? ""})`);
assert(r.ok, `the strict child exited 0 (got exit ${r.exitCode})`);
assert(
  (r.toolUses?.length ?? 0) > 0,
  `the child really called a tool (${r.toolUses?.length ?? 0})`,
);
assert(r.text.includes("DONE"), "the child reached its final reply");

// The tool's identity: exactly one `forge_read`, and it answered with the
// parent's credential. A child that had TWO registrations would have shown a
// load error above, and a child whose one tool was not the broker tool answers
// with a `gh`/`auth` refusal or nothing at all.
const forgeResults = (r.toolResults ?? []).filter((x) => x.toolName === "forge_read");
assert(
  forgeResults.length === 1,
  `one forge_read call landed in the child's roster (${forgeResults.length})`,
);
const forgeText = forgeResults.map((x) => x.text).join(" ");
assert(
  forgeResults.length === 1 && !forgeResults[0].isError && forgeText.includes(String(issueNumber)),
  `the one forge_read answered issue #${issueNumber} through the parent's broker (${JSON.stringify(
    forgeResults.map((x) => `${x.isError ? "ERR" : "ok"}:${x.text.slice(0, 120)}`),
  )})`,
);
assert(
  !/not logged|gh auth|unauthenticated|To get started with GitHub CLI|no parent forge-read broker/i.test(
    forgeText,
  ),
  "the read never fell back to an unauthenticated gh or a missing broker",
);

if (exit === 0) console.log("✓ all strict-child forge_read live assertions passed");
process.exit(exit);
