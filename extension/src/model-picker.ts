import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type PiModel, listAvailableModels } from "./list-models.ts";
import {
  GLOBAL_KEY,
  clearAllOverrides,
  clearOverride,
  getAllOverrides,
  setGlobalOverride,
  setOverride,
} from "./model-config.ts";
import { resolveModel } from "./models.ts";
import { ROLE_NAMES } from "./roles.ts";

const SUBAGENT_ROLES = ROLE_NAMES.filter((r) => r !== "project-manager");
const ALL_OPTION = "all subagents (default for unset roles)";
const RESET_ALL = "── reset all overrides ──";
const CUSTOM_MODEL = "── type a custom model id ──";
const USE_PI_DEFAULT = "── use Pi default (clear this role's override) ──";

export function registerModelPicker(pi: ExtensionAPI) {
  pi.registerCommand("ensemble-model", {
    description: "Pick subagent model per role (persists across sessions)",
    handler: async (_args, ctx) => {
      // Step 1: pick a role (or "all subagents", or "reset all")
      const overrides = getAllOverrides();
      const roleOptions = [
        formatRow(ALL_OPTION, overrides[GLOBAL_KEY]),
        ...SUBAGENT_ROLES.map((r) => formatRow(r, overrides[r])),
        RESET_ALL,
      ];
      const rolePick = await ctx.ui.select("Pick a role to configure", roleOptions);
      if (!rolePick) return;

      if (rolePick === RESET_ALL) {
        const yes = await ctx.ui.confirm(
          "Reset all overrides?",
          "This clears ensemble-models.json. Env vars (PI_ENSEMBLE_*) still apply if set.",
        );
        if (yes) {
          await clearAllOverrides();
          ctx.ui.notify("All ensemble-model overrides cleared.", "info");
        }
        return;
      }

      const role = parseRow(rolePick);
      const isGlobal = role === ALL_OPTION;
      const roleKey = isGlobal ? GLOBAL_KEY : role;
      const roleLabel = isGlobal ? "all subagents" : role;

      // Step 2: pick a model — group by provider, no hardcoded model IDs
      // so the list stays correct as Pi's catalog evolves.
      ctx.ui.notify("Loading models from pi --list-models …", "info");
      const models = await listAvailableModels();
      const modelOptions = buildModelOptions(models);
      modelOptions.push(USE_PI_DEFAULT, CUSTOM_MODEL);

      const modelPick = await ctx.ui.select(`Model for ${roleLabel}`, modelOptions);
      if (!modelPick) return;

      if (modelPick === USE_PI_DEFAULT) {
        if (isGlobal) {
          await clearOverride(GLOBAL_KEY);
        } else {
          await clearOverride(role);
        }
        ctx.ui.notify(
          `Cleared override for ${roleLabel}. Now falls through to env/default.`,
          "info",
        );
        return;
      }

      let modelId: string;
      if (modelPick === CUSTOM_MODEL) {
        const typed = await ctx.ui.input(
          "Type a model id",
          "<provider>/<model>  — run `pi --list-models` to see options",
        );
        if (!typed || typed.trim().length === 0) return;
        modelId = typed.trim();
      } else if (modelPick.startsWith("── ")) {
        // user picked a section header
        return;
      } else {
        modelId = parseModelLine(modelPick);
      }

      // Step 3: confirm and save
      if (isGlobal) {
        await setGlobalOverride(modelId);
      } else {
        await setOverride(role, modelId);
      }

      const resolved = isGlobal ? "(applies to roles without their own override)" : "";
      ctx.ui.notify(
        `Saved: ${roleLabel} → ${modelId}\n${resolved}\nWritten to ~/.pi/agent/ensemble-models.json.`,
        "info",
      );
    },
  });
}

function formatRow(label: string, current: string | undefined): string {
  if (!current) return label;
  const eff = label === ALL_OPTION ? current : current;
  return `${label}  →  ${eff}`;
}

function parseRow(row: string): string {
  // strip trailing "  →  <model>" if present
  const i = row.indexOf("  →  ");
  return i < 0 ? row : row.slice(0, i);
}

function formatModelLine(m: { id: string; context?: string; thinking?: string }): string {
  const tags: string[] = [];
  if (m.context) tags.push(m.context);
  if (m.thinking === "yes") tags.push("thinks");
  const trail = tags.length ? `   (${tags.join(", ")})` : "";
  return `${m.id}${trail}`;
}

function parseModelLine(line: string): string {
  // "<provider>/<model>   (ctx, thinks)" → "<provider>/<model>"
  const i = line.indexOf("   (");
  return i < 0 ? line : line.slice(0, i);
}

/**
 * Group available models by provider with a section header per provider.
 *
 * Provider order: subscription-based providers (where Pi can OAuth) first so
 * they're easy to reach, then alphabetical by provider name. Within each
 * provider, models are listed in the order Pi returned them.
 *
 * NB: this intentionally has zero hardcoded model IDs. Whatever Pi knows about
 * appears verbatim — no regex match against specific names that could rot.
 */
function buildModelOptions(models: PiModel[]): string[] {
  if (models.length === 0) return [];
  const byProvider = new Map<string, PiModel[]>();
  for (const m of models) {
    const arr = byProvider.get(m.provider) ?? [];
    arr.push(m);
    byProvider.set(m.provider, arr);
  }
  // Subscription providers Pi handles via OAuth/login.
  const subscriptionProviders = new Set(["anthropic", "github-copilot", "openai"]);
  const sortedProviders = [...byProvider.keys()].sort((a, b) => {
    const aSub = subscriptionProviders.has(a) ? 0 : 1;
    const bSub = subscriptionProviders.has(b) ? 0 : 1;
    if (aSub !== bSub) return aSub - bSub;
    return a.localeCompare(b);
  });
  const out: string[] = [];
  for (const provider of sortedProviders) {
    const list = byProvider.get(provider) ?? [];
    out.push(`── ${provider} (${list.length}) ──`);
    for (const m of list) out.push(formatModelLine(m));
  }
  return out;
}

/** Re-export used by ensemble-debug for status rendering. */
export function currentResolution() {
  return SUBAGENT_ROLES.map((role) => ({ role, choice: resolveModel(role) }));
}
