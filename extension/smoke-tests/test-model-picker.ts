#!/usr/bin/env bun
/**
 * Pure unit tests for the model-picker's item builders + value encoding.
 *
 * The interactive picker itself (`ctx.ui.custom` + SelectList) is only
 * exercisable in a live Pi session — see the README live-test checklist.
 * Here we cover the parts that don't depend on Pi's UI:
 *   - buildRoleItems shape (sentinel ordering, descriptions of current state)
 *   - buildModelItems shape (sentinel ordering, provider grouping, sort)
 *   - encodeModelValue / parseModelValue round-trip (handles slashes in model
 *     IDs correctly — e.g. `local-gpu|Qwen/Qwen3.6-35B-A3B-FP8`)
 */

import type { PiModel } from "../src/list-models.ts";
import type { ModelChoice } from "../src/model-config.ts";
import {
  buildModelItems,
  buildRoleItems,
  encodeModelValue,
  parseModelValue,
} from "../src/model-picker.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 1. encodeModelValue / parseModelValue — round trip.
{
  const v = encodeModelValue("anthropic", "claude-sonnet-4-7");
  const parsed = parseModelValue(v);
  assert(parsed?.provider === "anthropic", "round-trip: provider preserved (anthropic)");
  assert(parsed?.model === "claude-sonnet-4-7", "round-trip: model preserved (claude-sonnet-4-7)");
}

// 2. Round-trip with a model id that contains slashes (custom provider case).
{
  const v = encodeModelValue("local-gpu", "Qwen/Qwen3.6-35B-A3B-FP8");
  const parsed = parseModelValue(v);
  assert(parsed?.provider === "local-gpu", "round-trip: custom provider preserved");
  assert(
    parsed?.model === "Qwen/Qwen3.6-35B-A3B-FP8",
    "round-trip: model with slashes preserved (vendor/name)",
  );
}

// 3. parseModelValue rejects malformed values cleanly.
{
  assert(parseModelValue("no-separator-here") === undefined, "parseModelValue: no separator → undefined");
  assert(parseModelValue("|model-only") === undefined, "parseModelValue: empty provider → undefined");
  assert(parseModelValue("provider-only|") === undefined, "parseModelValue: empty model → undefined");
}

// 4. buildRoleItems — sentinels in expected positions, all subagent roles
//    listed, descriptions reflect current overrides.
{
  const overrides: Record<string, ModelChoice> = {
    __all__: { provider: "anthropic", model: "claude-sonnet-4-7" },
    developer: { provider: "local-gpu", model: "Qwen/Qwen3.6-35B-A3B-FP8" },
  };
  const items = buildRoleItems(overrides);
  // First item is "all subagents".
  assert(items[0]?.value === "__all_subagents__", "buildRoleItems[0] is __all_subagents__ sentinel");
  assert(items[0]?.label.includes("all subagents"), "buildRoleItems[0] label says 'all subagents'");
  assert(
    items[0]?.description?.includes("anthropic · claude-sonnet-4-7") ?? false,
    "buildRoleItems[0] description shows current global override",
  );
  // developer row has its override shown.
  const dev = items.find((i) => i.value === "developer");
  assert(dev !== undefined, "buildRoleItems contains a developer entry");
  assert(
    dev?.description?.includes("local-gpu · Qwen/Qwen3.6-35B-A3B-FP8") ?? false,
    "developer description shows current per-role override",
  );
  // An unset role shows fallthrough text.
  const ops = items.find((i) => i.value === "ops");
  assert(ops?.description === "(falls through to default)", "ops (unset) shows fallthrough description");
  // Last items: reset-all then cancel sentinels.
  const lastTwo = items.slice(-2).map((i) => i.value);
  assert(
    lastTwo[0] === "__reset_all__" && lastTwo[1] === "__cancel__",
    "buildRoleItems ends with reset-all then cancel sentinels",
  );
}

// 5. buildModelItems — sentinels first, models grouped subscription-providers
//    first then alphabetical, encoded values round-trip.
{
  const models: PiModel[] = [
    { provider: "huggingface", model: "Qwen/A", id: "huggingface/Qwen/A", context: "262K", thinking: "yes" },
    { provider: "anthropic", model: "claude-sonnet-4-7", id: "anthropic/claude-sonnet-4-7", context: "200K", thinking: "yes" },
    { provider: "local-gpu", model: "Qwen/Qwen3.6-35B-A3B-FP8", id: "local-gpu/Qwen/Qwen3.6-35B-A3B-FP8", context: "262K", thinking: "yes" },
    { provider: "cerebras", model: "zai-glm-4.7", id: "cerebras/zai-glm-4.7", context: "131K", thinking: "no" },
  ];
  const items = buildModelItems(models);
  // First three items are sentinels in fixed order.
  assert(items[0]?.value === "__pi_default__", "modelItems[0] = pi-default sentinel");
  assert(items[1]?.value === "__custom__", "modelItems[1] = custom-entry sentinel");
  assert(items[2]?.value === "__cancel__", "modelItems[2] = cancel sentinel");
  // Subscription providers first → anthropic appears before cerebras / huggingface / local-gpu.
  const realItems = items.slice(3);
  const providers = realItems.map((i) => {
    const parsed = parseModelValue(i.value);
    return parsed?.provider;
  });
  assert(providers[0] === "anthropic", "subscription provider (anthropic) appears first");
  // Non-subscription providers are alphabetical: cerebras, huggingface, local-gpu.
  const nonSub = providers.filter((p) => p !== "anthropic");
  const expectedNonSub = ["cerebras", "huggingface", "local-gpu"];
  assert(
    JSON.stringify(nonSub) === JSON.stringify(expectedNonSub),
    `non-subscription providers in alpha order (got ${JSON.stringify(nonSub)})`,
  );
  // Description carries provider + context + thinking flag.
  const local-gpu = realItems.find((i) => parseModelValue(i.value)?.provider === "local-gpu");
  assert(
    local-gpu?.description?.includes("local-gpu") ?? false,
    "local-gpu description names the provider",
  );
  assert(local-gpu?.description?.includes("262K") ?? false, "local-gpu description shows context");
  assert(local-gpu?.description?.includes("thinks") ?? false, "local-gpu description shows thinking flag");
  // The displayed label is the model (without provider prefix).
  assert(local-gpu?.label === "Qwen/Qwen3.6-35B-A3B-FP8", "local-gpu label is the model id (no provider prefix)");
}

// 6. buildModelItems with empty model list still emits the sentinels.
{
  const items = buildModelItems([]);
  assert(items.length === 3, "empty model list → only the 3 sentinel rows");
  assert(items[0]?.value === "__pi_default__", "empty list: sentinel[0] = pi-default");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
