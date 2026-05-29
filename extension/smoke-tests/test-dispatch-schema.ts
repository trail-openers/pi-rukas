#!/usr/bin/env bun
/**
 * Schema-shape regression test for dispatch_specialist and dispatch_parallel.
 *
 * Issue #92: agents must not pick subagent provider/model per dispatch — that
 * decision belongs to the user via /ensemble-model and PI_ENSEMBLE_* env vars.
 * Guards against accidental re-introduction of the `model` parameter on either
 * tool schema, and verifies the defence-in-depth strip helper actually drops
 * `model` even when a client ignores the schema.
 *
 * Bypasses Pi: stubs the ExtensionAPI surface, runs registerDispatchTools,
 * inspects the captured Typebox schemas.
 */

import { registerDispatchTools, stripModelOverride } from "../src/dispatch.ts";
import type { DispatchSpec } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface ToolDef {
  name: string;
  parameters: {
    properties?: Record<string, unknown>;
    items?: { properties?: Record<string, unknown> };
  };
}

const tools = new Map<string, ToolDef>();
// biome-ignore lint/suspicious/noExplicitAny: stub surface intentionally loose
const pi: any = {
  registerTool: (def: ToolDef) => tools.set(def.name, def),
  on: () => undefined,
  sendUserMessage: () => undefined,
};
registerDispatchTools(pi);

const specialist = tools.get("dispatch_specialist");
const parallel = tools.get("dispatch_parallel");

assert(specialist !== undefined, "dispatch_specialist is registered");
assert(parallel !== undefined, "dispatch_parallel is registered");

// --- Schema absence (issue #92) ---

const specialistProps = specialist?.parameters.properties ?? {};
assert(
  !("model" in specialistProps),
  "dispatch_specialist schema does NOT expose `model`",
);

const parallelSpecsItems = parallel?.parameters.properties?.specs as
  | { items?: { properties?: Record<string, unknown> } }
  | undefined;
const parallelItemProps = parallelSpecsItems?.items?.properties ?? {};
assert(
  !("model" in parallelItemProps),
  "dispatch_parallel.specs[] schema does NOT expose `model`",
);

// Sanity: the legitimate fields stayed.
assert("role" in specialistProps, "dispatch_specialist still declares `role`");
assert("prompt" in specialistProps, "dispatch_specialist still declares `prompt`");
assert("cwd" in specialistProps, "dispatch_specialist still declares `cwd`");
assert("role" in parallelItemProps, "dispatch_parallel.specs[] still declares `role`");
assert("prompt" in parallelItemProps, "dispatch_parallel.specs[] still declares `prompt`");

// --- Runtime defence: stripModelOverride drops `model` ---

const withModel = {
  role: "developer",
  prompt: "hello",
  cwd: "/tmp",
  model: "anthropic/claude-opus-4-7",
} as DispatchSpec & { model: string };
const stripped = stripModelOverride(withModel);
assert(
  !("model" in stripped),
  "stripModelOverride removes the `model` field from a misaligned spec",
);
assert(stripped.role === "developer", "stripModelOverride preserves `role`");
assert(stripped.prompt === "hello", "stripModelOverride preserves `prompt`");
assert(stripped.cwd === "/tmp", "stripModelOverride preserves `cwd`");

const clean = { role: "ops", prompt: "yo" } as DispatchSpec;
const passthrough = stripModelOverride(clean);
assert(passthrough.role === "ops", "stripModelOverride is a no-op on specs without `model`");
assert(passthrough.prompt === "yo", "stripModelOverride preserves `prompt` on no-op");

console.log(exit === 0 ? "\nAll dispatch-schema checks passed." : "\nFAILED");
process.exit(exit);
