#!/usr/bin/env bun
/**
 * Pure unit test for the model resolution priority logic.
 * No Pi spawns; just exercises `resolveModel` under various env states.
 */

import {
  clearAllOverrides,
  loadOverrides,
  resetForTesting,
  setGlobalOverride,
  setOverride,
} from "../src/model-config.ts";
import { resolveModel } from "../src/models.ts";

// Use a throwaway config file for the test so we don't clobber the user's.
process.env.PI_ENSEMBLE_MODELS_CONFIG = `/tmp/pi-ensemble-test-models-${process.pid}.json`;
await loadOverrides();
await clearAllOverrides();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Save and clear any env vars the test would interfere with.
const savedSub = process.env.PI_ENSEMBLE_SUBAGENT_MODEL;
const savedRoleDev = process.env.PI_ENSEMBLE_MODEL_DEVELOPER;
const savedRoleAdv = process.env.PI_ENSEMBLE_MODEL_ADVERSARIAL_DEVELOPER;
delete process.env.PI_ENSEMBLE_SUBAGENT_MODEL;
delete process.env.PI_ENSEMBLE_MODEL_DEVELOPER;
delete process.env.PI_ENSEMBLE_MODEL_ADVERSARIAL_DEVELOPER;

// 1. No env, no override → Pi default
{
  const r = resolveModel("developer");
  assert(r.model === undefined && r.source === "default", "no env → Pi default");
}

// 2. Global env set → all roles pick it up
{
  process.env.PI_ENSEMBLE_SUBAGENT_MODEL = "cerebras/zai-glm-4.7";
  const r = resolveModel("developer");
  assert(
    r.model === "cerebras/zai-glm-4.7" && r.source === "subagent-env",
    "PI_ENSEMBLE_SUBAGENT_MODEL applies to all roles",
  );
}

// 3. Per-role env beats global
{
  process.env.PI_ENSEMBLE_MODEL_DEVELOPER = "cerebras/gpt-oss-120b";
  const dev = resolveModel("developer");
  const exp = resolveModel("explore");
  assert(
    dev.model === "cerebras/gpt-oss-120b" && dev.source === "role-env",
    "PI_ENSEMBLE_MODEL_DEVELOPER overrides global for developer",
  );
  assert(
    exp.model === "cerebras/zai-glm-4.7" && exp.source === "subagent-env",
    "other roles still fall back to global env",
  );
}

// 4. Role with hyphenated name maps to underscored env var
{
  process.env.PI_ENSEMBLE_MODEL_ADVERSARIAL_DEVELOPER = "cerebras/qwen-3-235b-a22b-instruct-2507";
  const adv = resolveModel("adversarial-developer");
  assert(
    adv.model === "cerebras/qwen-3-235b-a22b-instruct-2507" && adv.source === "role-env",
    "hyphenated role 'adversarial-developer' → PI_ENSEMBLE_MODEL_ADVERSARIAL_DEVELOPER",
  );
}

// 5. Per-call override wins over everything
{
  const r = resolveModel("developer", "cerebras/llama3.1-8b");
  assert(
    r.model === "cerebras/llama3.1-8b" && r.source === "spec",
    "spec.model overrides per-role env",
  );
}

// 6. Empty/whitespace override is treated as unset
{
  const r = resolveModel("developer", "  ");
  assert(r.source === "role-env", "whitespace-only spec.model is ignored");
}

// 7. /ensemble-model per-role override beats env vars
{
  await setOverride("developer", { model: "cerebras/zai-glm-4.7" });
  const r = resolveModel("developer");
  assert(
    r.model === "cerebras/zai-glm-4.7" && r.source === "config",
    "/ensemble-model per-role override beats env",
  );
  await clearAllOverrides();
}

// 8. /ensemble-model all-subagents default beats env defaults but not per-role env
{
  await setGlobalOverride({ model: "cerebras/zai-glm-4.7" });
  const r = resolveModel("ops");
  assert(
    r.model === "cerebras/zai-glm-4.7" && r.source === "config-default",
    "/ensemble-model all-subagents default applies when role has no other override",
  );
  // developer has PI_ENSEMBLE_MODEL_DEVELOPER set above — config beats it too
  const dev = resolveModel("developer");
  assert(
    dev.model === "cerebras/zai-glm-4.7" && dev.source === "config-default",
    "/ensemble-model all-subagents default beats PI_ENSEMBLE_MODEL_DEVELOPER",
  );
  await clearAllOverrides();
}

// 9. Per-call spec still wins over /ensemble-model
{
  await setOverride("developer", { model: "cerebras/zai-glm-4.7" });
  const r = resolveModel("developer", "anthropic/claude-sonnet-4-5");
  assert(
    r.model === "anthropic/claude-sonnet-4-5" && r.source === "spec",
    "spec.model overrides /ensemble-model config",
  );
  await clearAllOverrides();
}

// 10. Custom provider via /ensemble-model — provider carried through to resolveModel
{
  await setOverride("developer", { provider: "my-vllm", model: "vendor/some-model" });
  const r = resolveModel("developer");
  assert(
    r.provider === "my-vllm" && r.model === "vendor/some-model" && r.source === "config",
    "/ensemble-model {provider, model} preserves provider on read",
  );
  await clearAllOverrides();
}

// 11. PI_ENSEMBLE_PROVIDER_<ROLE> pairs with PI_ENSEMBLE_MODEL_<ROLE>
const savedRoleDevProvider = process.env.PI_ENSEMBLE_PROVIDER_DEVELOPER;
const savedSubProvider = process.env.PI_ENSEMBLE_SUBAGENT_PROVIDER;
{
  process.env.PI_ENSEMBLE_PROVIDER_DEVELOPER = "my-vllm";
  process.env.PI_ENSEMBLE_MODEL_DEVELOPER = "vendor/some-model";
  const r = resolveModel("developer");
  assert(
    r.provider === "my-vllm" && r.model === "vendor/some-model" && r.source === "role-env",
    "PI_ENSEMBLE_PROVIDER_DEVELOPER pairs with PI_ENSEMBLE_MODEL_DEVELOPER",
  );
}

// 12. PI_ENSEMBLE_PROVIDER_<ROLE> alone (without paired MODEL) is ignored at that tier
{
  delete process.env.PI_ENSEMBLE_MODEL_DEVELOPER;
  // PROVIDER still set from test 11
  process.env.PI_ENSEMBLE_SUBAGENT_MODEL = "fallback/model";
  const r = resolveModel("developer");
  // Tier should fall through to subagent-env since role-env has no MODEL
  assert(
    r.source === "subagent-env" && r.model === "fallback/model",
    "PI_ENSEMBLE_PROVIDER_DEVELOPER alone falls through to subagent-env tier",
  );
  delete process.env.PI_ENSEMBLE_PROVIDER_DEVELOPER;
  delete process.env.PI_ENSEMBLE_SUBAGENT_MODEL;
}

// 13. PI_ENSEMBLE_SUBAGENT_PROVIDER pairs with PI_ENSEMBLE_SUBAGENT_MODEL
{
  process.env.PI_ENSEMBLE_SUBAGENT_MODEL = "vendor/some-model";
  process.env.PI_ENSEMBLE_SUBAGENT_PROVIDER = "my-vllm";
  const r = resolveModel("ops");
  assert(
    r.provider === "my-vllm" && r.model === "vendor/some-model" && r.source === "subagent-env",
    "PI_ENSEMBLE_SUBAGENT_PROVIDER pairs with PI_ENSEMBLE_SUBAGENT_MODEL",
  );
  delete process.env.PI_ENSEMBLE_SUBAGENT_PROVIDER;
  delete process.env.PI_ENSEMBLE_SUBAGENT_MODEL;
}

// 14. Legacy string-form ensemble-models.json entry still loads (backwards compat).
// Write the legacy string-only schema directly to disk and re-load.
{
  const fs = await import("node:fs/promises");
  const legacyPath = process.env.PI_ENSEMBLE_MODELS_CONFIG ?? "";
  await fs.writeFile(
    legacyPath,
    JSON.stringify({ models: { developer: "legacy/model-id" } }),
    "utf8",
  );
  // resetForTesting clears the `loaded` flag so loadOverrides re-reads disk.
  resetForTesting();
  await loadOverrides();
  const r = resolveModel("developer");
  assert(
    r.model === "legacy/model-id" && r.provider === undefined && r.source === "config",
    "legacy string-form ensemble-models.json entry resolves with provider undefined",
  );
  await clearAllOverrides();
}

// Restore provider env vars
if (savedRoleDevProvider) process.env.PI_ENSEMBLE_PROVIDER_DEVELOPER = savedRoleDevProvider;
else delete process.env.PI_ENSEMBLE_PROVIDER_DEVELOPER;
if (savedSubProvider) process.env.PI_ENSEMBLE_SUBAGENT_PROVIDER = savedSubProvider;
else delete process.env.PI_ENSEMBLE_SUBAGENT_PROVIDER;

// Restore env
if (savedSub) process.env.PI_ENSEMBLE_SUBAGENT_MODEL = savedSub;
else delete process.env.PI_ENSEMBLE_SUBAGENT_MODEL;
if (savedRoleDev) process.env.PI_ENSEMBLE_MODEL_DEVELOPER = savedRoleDev;
else delete process.env.PI_ENSEMBLE_MODEL_DEVELOPER;
if (savedRoleAdv) process.env.PI_ENSEMBLE_MODEL_ADVERSARIAL_DEVELOPER = savedRoleAdv;
else delete process.env.PI_ENSEMBLE_MODEL_ADVERSARIAL_DEVELOPER;

console.log(`\nexit ${exit}`);
process.exit(exit);
