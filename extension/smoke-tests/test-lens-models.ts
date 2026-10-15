#!/usr/bin/env bun
/**
 * #1348 — per-lens models, and the opt-in per-model bound on lens children.
 *
 * Every lens child runs as `code-review-specialist`, so the per-role vars
 * cannot spread the six lenses across models. Covers:
 *   1. resolveModel's lens tier: `PI_ENSEMBLE_MODEL_LENS_<LENS>` (+ paired
 *      provider) wins over the role's choice; without it the role tier and
 *      today's order apply unchanged; a provider var alone is ignored.
 *   2. The wiring: runLensReview → runLensChild → spawnSpecialist carries
 *      each lens's name on the spec (spawn.ts stubbed, no real children).
 *   3. `PI_ENSEMBLE_LENS_MODEL_CONCURRENCY`: unset, all lenses start
 *      together (today's fan-out); set, at most N run at once per resolved
 *      model, and a lens on its own model does not wait for the others.
 */

import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

let exit = 0;
function assert(cond: boolean, msg: string, actual?: unknown) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}${actual !== undefined ? ` (got ${JSON.stringify(actual)})` : ""}`);
    exit = 1;
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "lens-models-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
// A private model config, so the operator's /ensemble-model choices do not leak in.
process.env.PI_ENSEMBLE_MODELS_CONFIG = path.join(tmp, "ensemble-models.json");
const VARS = [
  "PI_ENSEMBLE_SUBAGENT_MODEL",
  "PI_ENSEMBLE_SUBAGENT_PROVIDER",
  "PI_ENSEMBLE_MODEL_CODE_REVIEW_SPECIALIST",
  "PI_ENSEMBLE_PROVIDER_CODE_REVIEW_SPECIALIST",
  "PI_ENSEMBLE_MODEL_LENS_SECURITY",
  "PI_ENSEMBLE_PROVIDER_LENS_SECURITY",
  "PI_ENSEMBLE_MODEL_LENS_ERROR_HANDLING",
  "PI_ENSEMBLE_PROVIDER_LENS_ERROR_HANDLING",
  "PI_ENSEMBLE_LENS_MODEL_CONCURRENCY",
];
for (const v of VARS) delete process.env[v];

// The spawn stub records each spec and the peak concurrency per model.
const specs: Array<{ role: string; lens?: string }> = [];
let running = 0;
let peak = 0;
const runningByModel = new Map<string, number>();
const peakByModel = new Map<string, number>();
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => `run-1348-${Date.now()}`,
  spawnSpecialist: async (spec: { role: string; lens?: string }) => {
    specs.push(spec);
    const m = resolveModel(spec.role, undefined, spec.lens).model ?? "(default)";
    running++;
    peak = Math.max(peak, running);
    runningByModel.set(m, (runningByModel.get(m) ?? 0) + 1);
    peakByModel.set(m, Math.max(peakByModel.get(m) ?? 0, runningByModel.get(m) ?? 0));
    await new Promise((r) => setTimeout(r, 40));
    running--;
    runningByModel.set(m, (runningByModel.get(m) ?? 1) - 1);
    return {
      role: spec.role,
      ok: true,
      text: "Nothing in this lane.\n\nSkill Load Status: SUCCESS",
      toolUses: [],
      ms: 40,
      exitCode: 0,
    };
  },
}));

const { resolveModel } = await import("../src/models.ts");
const { loadOverrides, setOverride, clearAllOverrides } = await import("../src/model-config.ts");
const { lensModelConcurrency, lensModelSlotStats, withLensModelSlot } = await import(
  "../src/lens-model-slots.ts"
);
const { runLensReview } = await import("../src/lens-review.ts");
const { LENS_ROSTER } = await import("../src/lens-roster.ts");
await loadOverrides();
await clearAllOverrides();

const ROLE = "code-review-specialist";

// ── 1. resolveModel's lens tier.
{
  let r = resolveModel(ROLE, undefined, "SECURITY");
  assert(r.source === "default" && r.model === undefined, "no vars → Pi default (today)", r);

  process.env.PI_ENSEMBLE_MODEL_CODE_REVIEW_SPECIALIST = "role-model";
  r = resolveModel(ROLE, undefined, "SECURITY");
  assert(r.source === "role-env" && r.model === "role-model", "no lens var → the role's model", r);

  process.env.PI_ENSEMBLE_PROVIDER_LENS_SECURITY = "lonely-provider";
  r = resolveModel(ROLE, undefined, "SECURITY");
  assert(
    r.source === "role-env" && r.provider === undefined,
    "a lens provider alone is ignored",
    r,
  );

  process.env.PI_ENSEMBLE_MODEL_LENS_SECURITY = "sec-model";
  r = resolveModel(ROLE, undefined, "SECURITY");
  assert(
    r.source === "lens-env" &&
      r.model === "sec-model" &&
      r.provider === "lonely-provider" &&
      r.envVar === "PI_ENSEMBLE_MODEL_LENS_SECURITY",
    "the lens var (+ paired provider) wins over the role var",
    r,
  );
  r = resolveModel(ROLE, undefined, "PERFORMANCE");
  assert(r.model === "role-model", "another lens keeps the role's model", r);
  r = resolveModel(ROLE);
  assert(r.model === "role-model", "a non-lens dispatch of the role is unaffected", r);

  await setOverride(ROLE, { model: "picked-model" });
  r = resolveModel(ROLE, undefined, "SECURITY");
  assert(r.model === "sec-model", "the lens var wins over an /ensemble-model role choice", r);
  r = resolveModel(ROLE, undefined, "PERFORMANCE");
  assert(r.source === "config", "a lens without its var falls back to /ensemble-model", r);
  await clearAllOverrides();

  process.env.PI_ENSEMBLE_MODEL_LENS_ERROR_HANDLING = "eh-model";
  r = resolveModel(ROLE, undefined, "error-handling");
  assert(r.model === "eh-model", "the tag form `error-handling` names ERROR_HANDLING", r);
  r = resolveModel(ROLE, "spec-model", "SECURITY");
  assert(r.source === "spec", "a per-call spec model still wins", r);
  r = resolveModel("developer", undefined, "SECURITY");
  assert(r.source === "default", "a non-lens role ignores `lens` (no borrowed lens model)", r);
  for (const v of VARS) delete process.env[v];
}

// ── 2 + 3. Through the real fan-out.
const skillsDir = path.join(tmp, "skills");
let prec = 10;
for (const l of LENS_ROSTER) {
  mkdirSync(path.join(skillsDir, l.skill), { recursive: true });
  writeFileSync(
    path.join(skillsDir, l.skill, "SKILL.md"),
    `---\nname: ${l.skill}\nprecedence: ${prec}\n---\n`,
  );
  prec += 10;
}
process.env.PI_ENSEMBLE_SKILLS_DIR = skillsDir;
const lensNames = LENS_ROSTER.map((l) => l.name).sort();

async function review(): Promise<void> {
  specs.length = 0;
  peak = 0;
  peakByModel.clear();
  runningByModel.clear();
  const s = await runLensReview({ diff: "diff --git a/x b/x\n+x\n", cwd: tmp });
  assert(
    s.lenses.filter((l) => !l.blocked).length === lensNames.length,
    "every lens ran",
    s.lenses,
  );
}

{
  assert(lensModelConcurrency() === 0, "the bound is off by default");
  await review();
  const got = specs.map((s) => s.lens).sort();
  assert(JSON.stringify(got) === JSON.stringify(lensNames), "each spawn spec names its lens", got);
  assert(
    specs.every((s) => s.role === ROLE),
    "every lens still runs as code-review-specialist",
  );
  assert(peak === lensNames.length, `unset: all ${lensNames.length} lenses start together`, peak);

  process.env.PI_ENSEMBLE_LENS_MODEL_CONCURRENCY = "2";
  await review();
  assert(peak === 2, "LENS_MODEL_CONCURRENCY=2, one model: at most 2 run at once", peak);

  process.env.PI_ENSEMBLE_LENS_MODEL_CONCURRENCY = "1";
  process.env.PI_ENSEMBLE_MODEL_LENS_SECURITY = "sec-model";
  await review();
  assert(peakByModel.get("sec-model") === 1, "the lens on its own model ran", [...peakByModel]);
  assert(peakByModel.get("(default)") === 1, "the shared model ran one at a time", [
    ...peakByModel,
  ]);
  assert(peak === 2, "a lens on its own model does not wait behind the shared one", peak);

  process.env.PI_ENSEMBLE_LENS_MODEL_CONCURRENCY = "bogus";
  assert(lensModelConcurrency() === 0, "an invalid bound means no bound");
  process.env.PI_ENSEMBLE_LENS_MODEL_CONCURRENCY = "0";
  assert(lensModelConcurrency() === 0, "0 means no bound");
}

// ── 4. Slots are released on a throw and on an abort.
{
  process.env.PI_ENSEMBLE_LENS_MODEL_CONCURRENCY = "1";
  const L = "SECURITY";
  let threw = false;
  try {
    await withLensModelSlot(L, async () => {
      throw new Error("child blew up");
    });
  } catch {
    threw = true;
  }
  const afterThrow = lensModelSlotStats(L);
  assert(threw && afterThrow.active === 0, "a throwing lens child frees its slot", afterThrow);

  // A lens queued behind a running one leaves the queue on abort and runs at once.
  let release = () => {};
  const holder = withLensModelSlot(L, () => new Promise<void>((r) => (release = r)));
  const ac = new AbortController();
  let ranQueued = false;
  const queued = withLensModelSlot(
    L,
    async () => {
      ranQueued = true;
    },
    ac.signal,
  );
  await new Promise((r) => setTimeout(r, 10));
  const waiting = lensModelSlotStats(L);
  assert(
    waiting.active === 1 && waiting.queued === 1 && !ranQueued,
    "a second lens queues",
    waiting,
  );
  ac.abort();
  await queued;
  const afterAbort = lensModelSlotStats(L);
  assert(
    ranQueued && afterAbort.queued === 0,
    "an abort lets the queued lens leave at once",
    afterAbort,
  );
  assert(
    afterAbort.active === 1,
    "the aborted waiter took no slot from the running lens",
    afterAbort,
  );
  release();
  await holder;
  const done = lensModelSlotStats(L);
  assert(done.active === 0 && done.queued === 0, "the running lens frees its slot", done);
  delete process.env.PI_ENSEMBLE_LENS_MODEL_CONCURRENCY;
}

process.exit(exit);
