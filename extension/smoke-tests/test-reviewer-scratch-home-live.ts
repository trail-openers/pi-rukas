#!/usr/bin/env bun
/**
 * LIVE: a confined (read-only) child through the real spawn path (#2368).
 *
 * The outage this pins: since the scratch-HOME redirect shipped, every
 * read-only child — `explore`, `code-review-specialist`,
 * `adversarial-developer`, a `/plan` investigator — died about eight seconds
 * after spawn with
 * `Error: Unknown provider "<id>". Use --list-models to see available
 * providers/models.` while a developer or ops child ran fine. The redirect is
 * applied to the CHILD PROCESS env, so the child's own pi resolves its config
 * dir from the scratch `HOME`; pi reads that dir from `PI_CODING_AGENT_DIR`
 * (`config.js` `getAgentDir`) and falls back to `<HOME>/.pi/agent`, so the child
 * opened `<scratch>/.pi/agent` — no `models.json`, no `auth.json`, no
 * `settings.json` — and died in model resolution before its first turn. The fix
 * re-exports `PI_CODING_AGENT_DIR` at the parent's resolved value
 * (`reviewer-scratch-home.ts`).
 *
 * Why a live test when the offline one covers the env: the offline test proves
 * the variable is in the map. Only a real child proves the claim it stands for —
 * that a confined child still finds its provider, still runs `git log -1` in the
 * tree it was given, and still reaches the forge through the parent's broker.
 * Those three are the whole defect surface, and each is answered here by the
 * child's own actions, not by our reading of its env.
 *
 * Spawns a real Pi child, so it is `-live` and is excluded from the pre-push
 * set (verify-loop.sh skips `*-live.ts`). Cost: one short explore dispatch.
 *
 *   cd extension && bun run smoke-tests/test-reviewer-scratch-home-live.ts
 *
 * The RED half is run against the pre-fix source with the operator's own
 * workaround removed from the environment — this host exports
 * `PI_CODING_AGENT_DIR`, which masks the defect for every child:
 *
 *   env -u PI_CODING_AGENT_DIR bun run smoke-tests/test-reviewer-scratch-home-live.ts
 *
 * Two arms, both run every time, and a skip is never a pass:
 *   1. `explore` with no cwd (the shape `/plan` investigators use) — the child
 *      must start, call a tool, and return a report. This is the arm that died.
 *   2. `code-review-specialist` at the repo root — reviewer isolation relocates
 *      it to a throwaway tree and it must run `git log -1 --format=%H` there and
 *      echo the real head SHA, and must answer one `forge_read` (an issue read)
 *      with the parent's credential.
 *
 * The forge read is what `forge_read` exists for and what the child has no
 * other way to do: its env carries no token (`child-forge-env.ts` deleted all
 * five) and no operator config root (`GH_CONFIG_DIR` points at a per-child empty
 * dir), so `gh` is unauthenticated by construction. The read therefore proves
 * the parent-served broker, and an error naming `gh`/`auth` or a refusal to
 * reach the broker fails the test rather than passing on an empty reply.
 *
 * Set `PI_ENSEMBLE_LIVE_ISSUE` to a different issue number if #2352 stops
 * existing; the default is the issue the redirect shipped on.
 */

import { spawnSpecialist } from "../src/spawn.ts";

// Deliberately live: the offline anti-leak guard would refuse this spawn.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";
// Run the child the way a real dispatch does. A harness under `bun` is not a Pi
// parent session, so `isParentInTrustMode()` answers false and the child is
// planned strict: it gets the full pi-rukas extension forwarded BESIDE the
// child-guards companion and `PI_ENSEMBLE_SUBAGENT_MODE=1`, and pi then refuses
// the load outright (`Tool "forge_read" conflicts with …child-guards.ts`) —
// because outside a parent session nothing deduplicates the companion's
// registration. A real trust-mode parent forwards no full extension at all, so
// the child sees exactly one set of guards and one `forge_read`. `workCycleTrust`
// is what the /work driver sets on each of its dispatches for the same reason,
// which makes this the shape the field actually runs.
const WORK_CYCLE_TRUST = true;

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The provider-resolution failure the defect produced, in pi's own words. */
const PROVIDER_ERROR = /Unknown provider/i;

const repoRoot = process.cwd();
const issueNumber = process.env.PI_ENSEMBLE_LIVE_ISSUE ?? "2352";

// The parent session's own `GH_CONFIG_DIR` names a per-child empty dir that an
// EARLIER spawn's broker created and already removed (`child-forge-env.ts`
// makes it inside the broker's mkdtemp tree, `stop()` removes that tree). This
// harness inherits it, and the broker's `gh` would then read its credential
// helper config out of a directory that no longer exists — the read fails with
// `To get started with GitHub CLI`, which is this harness's artefact and not the
// child's or the parent's condition. A real parent session never hands this
// value down: it has no `GH_CONFIG_DIR` of its own, and every child gets a fresh
// one from the plan. Drop the stale one so the parent-side read runs under the
// operator's real config root, as it does in production.
if (process.env.GH_CONFIG_DIR && !(await Bun.file(`${process.env.GH_CONFIG_DIR}/hosts.yml`).exists())) {
  console.log(`[test] dropping stale GH_CONFIG_DIR=${process.env.GH_CONFIG_DIR} (no hosts.yml there)`);
  delete process.env.GH_CONFIG_DIR;
}

console.log(`[test] cwd=${repoRoot} PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR ?? "(unset → pi default)"}`);

// ── Arm 1: a confined child with no cwd starts, calls a tool, and returns ──
// The exact `/plan`-investigator shape: role `explore`, no cwd, so no reviewer
// tree — and the arm that died at ~8 s before the fix.
console.log("\n[test] arm 1: explore child (no cwd) — starts, runs bash, returns");
const a1 = await spawnSpecialist(
  {
    role: "explore",
    prompt: [
      "Deterministic probe. Follow EXACTLY, one bash call per step:",
      "1. Call bash with exactly: echo SCRATCH_PROBE_$((6*7))",
      "2. Then reply with exactly the four ASCII letters PONG and nothing else.",
      "Do not use any other tool. Do not write any files. Do not use vipune.",
    ].join("\n"),
  },
  { timeoutMs: 180_000, workCycleTrust: WORK_CYCLE_TRUST },
);
console.log(
  `[test] arm 1: ok=${a1.ok} exit=${a1.exitCode} ms=${a1.ms} model=${a1.model ?? "(none)"} text="${a1.text.slice(0, 80)}"`,
);
const a1All = `${a1.text}\n${a1.errorStop?.message ?? ""}`;
assert(!a1All.includes("FORBID_LIVE_SPAWN"), "arm 1: the spawn ran (no live-spawn refusal)");
assert(
  !PROVIDER_ERROR.test(a1All),
  `arm 1: no Unknown-provider death (got ${JSON.stringify(a1All.slice(0, 200))})`,
);
assert(a1.model !== undefined, "arm 1: pi resolved a model — a config dir with models.json was found");
assert(!a1.errorStop, `arm 1: no provider errorStop (${a1.errorStop?.message ?? ""})`);
assert(
  (a1.toolUses?.length ?? 0) > 0,
  `arm 1: the child really called a tool (${a1.toolUses?.length ?? 0})`,
);
assert(a1.text.includes("PONG"), "arm 1: the child returned its report");
assert(a1.ok, `arm 1: ok (exit ${a1.exitCode})`);

// ── Arm 2: a reviewer child in its isolated tree — git AND the forge read ──
console.log("\n[test] arm 2: code-review-specialist at the repo root — git log + forge_read");
const a2 = await spawnSpecialist(
  {
    role: "code-review-specialist",
    cwd: repoRoot,
    prompt: [
      "Deterministic probe. Follow EXACTLY, in this order, one tool call per step:",
      '1. Call bash with exactly: git log -1 --format=%H',
      `2. Call the \`forge_read\` tool with verb "issue_view" and number ${issueNumber}.`,
      "3. Then reply with three lines and nothing else:",
      "   SHA <the full sha step 1 printed>",
      "   ISSUE <the issue's number, or NOFORGE if step 2 failed>",
      "   DONE",
      "Do not use any other tool. Do not write files. Do not use vipune.",
    ].join("\n"),
  },
  { timeoutMs: 240_000, workCycleTrust: WORK_CYCLE_TRUST },
);
console.log(
  `[test] arm 2: ok=${a2.ok} exit=${a2.exitCode} ms=${a2.ms} model=${a2.model ?? "(none)"}`,
);
const a2All = `${a2.text}\n${a2.errorStop?.message ?? ""}`;
console.log(`[test] arm 2 reply: ${JSON.stringify(a2.text.slice(0, 300))}`);
assert(
  !PROVIDER_ERROR.test(a2All),
  `arm 2: no Unknown-provider death (got ${JSON.stringify(a2All.slice(0, 200))})`,
);
assert(a2.model !== undefined, "arm 2: pi resolved a model in the isolated tree");
assert(!a2.errorStop, `arm 2: no provider errorStop (${a2.errorStop?.message ?? ""})`);

// The git half: the child ran in the throwaway tree the reviewer isolation made
// at the reviewed HEAD, so the SHA it prints is the real head of this checkout.
const expectedSha = await Bun.$`git -C ${repoRoot} rev-parse HEAD`.text();
const reported = /SHA\s+([0-9a-f]{40})/.exec(a2.text)?.[1];
assert(
  reported === expectedSha.trim(),
  `arm 2: git log -1 in its tree returned the head (${reported ?? "(none)"} vs ${expectedSha.trim()})`,
);

// The forge half: the parent's broker, not the operator's login — which the
// child does not have. An empty or absent reply is a failure, never a pass.
const forgeResults = (a2.toolResults ?? []).filter((r) => r.toolName === "forge_read");
assert(
  forgeResults.length > 0,
  `arm 2: the child had a forge_read tool and called it (${(a2.toolResults ?? [])
    .map((r) => r.toolName)
    .join(", ")})`,
);
const forgeOk = forgeResults.some((r) => !r.isError && r.text.includes(`"number": ${issueNumber}`));
assert(
  forgeOk,
  `arm 2: forge_read answered issue #${issueNumber} with the parent's credential (${JSON.stringify(
    forgeResults.map((r) => `${r.isError ? "ERR" : "ok"}:${r.text.slice(0, 120)}`),
  )})`,
);
assert(
  !/not logged|gh auth|unauthenticated|To get started with GitHub CLI/i.test(
    forgeResults.map((r) => r.text).join(" "),
  ),
  "arm 2: the forge read never fell back to an unauthenticated gh",
);
assert(a2.text.includes("DONE"), "arm 2: the child reached its final reply");
assert(a2.ok, `arm 2: ok (exit ${a2.exitCode})`);

console.log(`\n[test] verdict: ${exit === 0 ? "PASS" : "FAIL"}`);
console.log(
  `[test] transcripts: ${a1.transcriptPath ?? "(none)"} | ${a2.transcriptPath ?? "(none)"}`,
);
process.exit(exit);
