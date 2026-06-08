import { GLOBAL_KEY, type ModelChoice, getOverride } from "./model-config.ts";
import { ROLE_NAMES, type RoleName } from "./roles.ts";

/**
 * Model selection for spawned specialists.
 *
 * Resolution order (first hit wins):
 *   1. Per-call override   — `model` field on a DispatchSpec (string)
 *   2. /ensemble-model     — per-role choice saved to ensemble-models.json
 *                            (or its all-subagents default). Carries both
 *                            `provider` and `model` for custom OpenAI-
 *                            compatible endpoints.
 *   3. Per-role env vars   — `PI_ENSEMBLE_MODEL_<ROLE>` plus the optional
 *                            `PI_ENSEMBLE_PROVIDER_<ROLE>` (uppercased,
 *                            `-` → `_`). The provider var alone is ignored;
 *                            it only takes effect when paired with the
 *                            model var at the same tier.
 *   4. Global env defaults — `PI_ENSEMBLE_SUBAGENT_MODEL` (+ optional
 *                            `PI_ENSEMBLE_SUBAGENT_PROVIDER`)
 *   5. (nothing)           — Pi child uses its own configured default,
 *                            same as the parent's default
 *
 * Model patterns follow Pi's syntax: for built-in providers, the compound
 * "provider/model" works on its own. For custom providers (registered in
 * ~/.pi/agent/models.json), set `provider` explicitly — Pi cannot otherwise
 * disambiguate a vendor model ID like "Qwen/Qwen3.6-35B-A3B-FP8" from
 * potentially identical IDs served by other providers.
 *
 * The parent (main agent) is NOT affected by these settings — it runs under
 * whatever model the user picked when launching `pi` (or the
 * defaultProvider/defaultModel from ~/.pi/agent/settings.json). To use
 * different models for parent vs subagents, set the parent via
 * `pi --provider X --model Y` (or the defaults in settings.json) and the
 * subagents via /ensemble-model or env vars.
 */

export interface ResolvedModelChoice {
  provider: string | undefined;
  model: string | undefined;
  source: "spec" | "config" | "config-default" | "role-env" | "subagent-env" | "default";
  envVar?: string;
  configKey?: string;
}

function roleEnvKey(role: string): string {
  return `PI_ENSEMBLE_MODEL_${role.toUpperCase().replaceAll("-", "_")}`;
}
function roleProviderEnvKey(role: string): string {
  return `PI_ENSEMBLE_PROVIDER_${role.toUpperCase().replaceAll("-", "_")}`;
}

function envValue(key: string): string | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveModel(role: string, override?: string): ResolvedModelChoice {
  if (override && override.trim().length > 0) {
    return {
      provider: undefined,
      model: override.trim(),
      source: "spec",
    };
  }
  const cfg = getOverride(role);
  if (cfg.choice) {
    return {
      provider: cfg.choice.provider,
      model: cfg.choice.model,
      source: cfg.key === GLOBAL_KEY ? "config-default" : "config",
      configKey: cfg.key,
    };
  }
  const roleKey = roleEnvKey(role);
  const roleModel = envValue(roleKey);
  if (roleModel) {
    return {
      provider: envValue(roleProviderEnvKey(role)),
      model: roleModel,
      source: "role-env",
      envVar: roleKey,
    };
  }
  const globalKey = "PI_ENSEMBLE_SUBAGENT_MODEL";
  const globalModel = envValue(globalKey);
  if (globalModel) {
    return {
      provider: envValue("PI_ENSEMBLE_SUBAGENT_PROVIDER"),
      model: globalModel,
      source: "subagent-env",
      envVar: globalKey,
    };
  }
  return { provider: undefined, model: undefined, source: "default" };
}

/** Snapshot of the current resolution for every role — used by /ensemble-debug. */
export function modelConfigSnapshot(): Array<{ role: RoleName; choice: ResolvedModelChoice }> {
  return ROLE_NAMES.filter((r) => r !== "project-manager").map((role) => ({
    role,
    choice: resolveModel(role),
  }));
}

/** Re-export so callers that previously imported the persisted shape don't need to know about model-config.ts. */
export type { ModelChoice } from "./model-config.ts";
