import { GLOBAL_KEY, getOverride } from "./model-config.ts";
import { ROLE_NAMES, type RoleName } from "./roles.ts";

/**
 * Model selection for spawned specialists.
 *
 * Resolution order (first hit wins):
 *   1. Per-call override   — `model` field on a DispatchSpec
 *   2. /ensemble-model     — per-role choice saved to ensemble-models.json
 *                            (or its all-subagents default)
 *   3. Per-role env var    — `PI_ENSEMBLE_MODEL_<ROLE>` (uppercased, `-` → `_`)
 *                            e.g. PI_ENSEMBLE_MODEL_DEVELOPER,
 *                                 PI_ENSEMBLE_MODEL_ADVERSARIAL_DEVELOPER
 *   4. Global env default  — `PI_ENSEMBLE_SUBAGENT_MODEL`
 *   5. (nothing)           — Pi child uses its own configured default,
 *                            same as the parent's default
 *
 * Model patterns follow Pi's syntax: "provider/model[:thinking]" or globs
 * like "*sonnet*". See `pi --list-models` for the full catalog.
 *
 * The parent (main agent) is NOT affected by these settings — it runs under
 * whatever model the user picked when launching `pi`. To use different models
 * for parent vs subagents, set the parent via `pi --model <id>` (or the
 * default in Pi settings) and the subagents via /ensemble-model or env vars.
 */

export interface ResolvedModelChoice {
  model: string | undefined;
  source: "spec" | "config" | "config-default" | "role-env" | "subagent-env" | "default";
  envVar?: string;
  configKey?: string;
}

function roleEnvKey(role: string): string {
  return `PI_ENSEMBLE_MODEL_${role.toUpperCase().replaceAll("-", "_")}`;
}

export function resolveModel(role: string, override?: string): ResolvedModelChoice {
  if (override && override.trim().length > 0) {
    return { model: override.trim(), source: "spec" };
  }
  const cfg = getOverride(role);
  if (cfg.model) {
    return {
      model: cfg.model,
      source: cfg.key === GLOBAL_KEY ? "config-default" : "config",
      configKey: cfg.key,
    };
  }
  const roleKey = roleEnvKey(role);
  const roleVal = process.env[roleKey];
  if (roleVal && roleVal.trim().length > 0) {
    return { model: roleVal.trim(), source: "role-env", envVar: roleKey };
  }
  const globalKey = "PI_ENSEMBLE_SUBAGENT_MODEL";
  const globalVal = process.env[globalKey];
  if (globalVal && globalVal.trim().length > 0) {
    return { model: globalVal.trim(), source: "subagent-env", envVar: globalKey };
  }
  return { model: undefined, source: "default" };
}

/** Snapshot of the current resolution for every role — used by /ensemble-debug. */
export function modelConfigSnapshot(): Array<{ role: RoleName; choice: ResolvedModelChoice }> {
  return ROLE_NAMES.filter((r) => r !== "project-manager").map((role) => ({
    role,
    choice: resolveModel(role),
  }));
}
