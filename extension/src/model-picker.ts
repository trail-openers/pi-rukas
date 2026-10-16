/**
 * /ensemble-model — interactive picker for per-subagent (and "all subagents")
 * model overrides.
 *
 * UX (Pi 0.78 verified): uses `ctx.ui.custom()` to embed a `SelectList`
 * component from `@earendil-works/pi-tui` — the same primitive Pi's own
 * `/model` / `/login` / `/theme` selectors use. That gives us arrow-key
 * navigation, type-as-you-filter, and `description` annotations per item.
 *
 * The older `ctx.ui.select(title, options[])` API renders as a numbered
 * text prompt in 0.78 (user types the literal option string), so it's
 * unsuitable for long model lists with structured IDs like
 * `local-gpu/Qwen/Qwen3.6-35B-A3B-FP8`. We keep `ctx.ui.input`
 * for the "type a custom model id" fallback path only.
 *
 * Both selection modes are preserved:
 *   - per-subagent override (one role, one model)
 *   - "all subagents" default (applies to roles without their own override)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type SelectItem, SelectList, type SelectListTheme } from "@earendil-works/pi-tui";
import { type PiModel, listAvailableModels } from "./list-models.ts";
import {
  GLOBAL_KEY,
  type ModelChoice,
  clearAllOverrides,
  clearOverride,
  getAllOverrides,
  setGlobalOverride,
  setOverride,
} from "./model-config.ts";
import { resolveModel } from "./models.ts";
import { SUBAGENT_ROLE_NAMES } from "./roles.ts";

// Sentinel values returned by the picker. Real role names cannot collide
// with these (no role contains "__" prefix in our naming).
const SENTINEL_ALL_SUBAGENTS = "__all_subagents__";
const SENTINEL_RESET_ALL = "__reset_all__";
const SENTINEL_PI_DEFAULT = "__pi_default__";
const SENTINEL_CUSTOM = "__custom__";
const SENTINEL_CANCEL = "__cancel__";

// Model value encoding: "<provider>|<model>". `|` is not valid in any Pi
// provider or model identifier (per `pi --list-models` output we've seen),
// so round-tripping is unambiguous even when the model itself contains `/`.
const MODEL_VALUE_SEP = "|";

export function registerModelPicker(pi: ExtensionAPI) {
  pi.registerCommand("ensemble-model", {
    description: "Pick subagent model per role (persists across sessions)",
    handler: async (_args, ctx) => {
      await runEnsembleModel(ctx);
    },
  });
}

async function runEnsembleModel(ctx: ExtensionCommandContext): Promise<void> {
  // Step 1: role pick (real interactive list).
  const overrides = getAllOverrides();
  const roleItems = buildRoleItems(overrides);
  const rolePick = await showPicker<string>(ctx, "Pick a role to configure", roleItems);
  if (rolePick === undefined || rolePick === SENTINEL_CANCEL) return;

  if (rolePick === SENTINEL_RESET_ALL) {
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

  const isGlobal = rolePick === SENTINEL_ALL_SUBAGENTS;
  const role = isGlobal ? GLOBAL_KEY : rolePick;
  const roleLabel = isGlobal ? "all subagents" : rolePick;

  // Step 2: model pick.
  ctx.ui.notify("Loading models from pi --list-models …", "info");
  const models = await listAvailableModels();
  const modelItems = buildModelItems(models);
  const modelPick = await showPicker<string>(ctx, `Model for ${roleLabel}`, modelItems);
  if (modelPick === undefined || modelPick === SENTINEL_CANCEL) return;

  if (modelPick === SENTINEL_PI_DEFAULT) {
    await clearOverride(role);
    ctx.ui.notify(`Cleared override for ${roleLabel}. Now falls through to env/default.`, "info");
    return;
  }

  let choice: ModelChoice;
  if (modelPick === SENTINEL_CUSTOM) {
    const typed = await promptCustomModel(ctx);
    if (!typed) return;
    choice = typed;
  } else {
    const parsed = parseModelValue(modelPick);
    if (!parsed) return;
    choice = parsed;
  }

  if (isGlobal) {
    await setGlobalOverride(choice);
  } else {
    await setOverride(role, choice);
  }

  const display = formatChoiceForNotify(choice);
  const resolved = isGlobal ? "(applies to roles without their own override)" : "";
  ctx.ui.notify(
    `Saved: ${roleLabel} → ${display}\n${resolved}\nWritten to ~/.pi/agent/ensemble-models.json.`,
    "info",
  );
}

// =============================================================================
// Picker primitives
// =============================================================================

/**
 * Show an interactive SelectList via `ctx.ui.custom`. Returns the selected
 * item's value, or undefined if the user cancelled (Esc / Ctrl-C). On any
 * environment where ctx.ui.custom isn't available (e.g. `pi -p` headless),
 * surface a clear notify and return undefined — the caller treats that as
 * cancel.
 *
 * IMPLEMENTATION NOTE: We return the SelectList directly, NOT wrapped in a
 * Container. pi-tui's Container does not implement `handleInput` — only
 * `render` and `invalidate` (verified in tui.js). Pi's TUI overlay routes
 * keyboard input ONLY to the focused component via its `handleInput`
 * method (see `focusedComponent.handleInput(data)` in tui.js). Wrapping
 * SelectList in a Container therefore swallows every keystroke including
 * Ctrl-C, locking the user out (PR #176 regression — this file's previous
 * Container wrapper had exactly that bug). The title context is provided
 * via the `ctx.ui.notify` call immediately before opening the picker.
 */
async function showPicker<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
): Promise<T | undefined> {
  ctx.ui.notify(title, "info");
  try {
    return await ctx.ui.custom<T | undefined>((_tui, theme, _keybindings, done) => {
      const selectListTheme: SelectListTheme = {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.bg("selectedBg", t),
        description: (t) => theme.fg("dim", t),
        scrollInfo: (t) => theme.fg("muted", t),
        noMatch: (t) => theme.fg("muted", t),
      };
      const list = new SelectList(items, 12, selectListTheme, {
        minPrimaryColumnWidth: 24,
        maxPrimaryColumnWidth: 48,
      });
      list.onSelect = (item) => done(item.value as T);
      list.onCancel = () => done(undefined);
      return list;
    });
  } catch (err) {
    ctx.ui.notify(
      `/ensemble-model requires interactive mode. Edit ~/.pi/agent/ensemble-models.json directly (see README). (${(err as Error).message})`,
      "warning",
    );
    return undefined;
  }
}

// =============================================================================
// Item builders (pure functions, easy to unit-test)
// =============================================================================

export function buildRoleItems(overrides: Record<string, ModelChoice>): SelectItem[] {
  const items: SelectItem[] = [];
  // "all subagents" first — it's the most common selection in practice.
  items.push({
    value: SENTINEL_ALL_SUBAGENTS,
    label: "all subagents (default for unset roles)",
    description: describeOverride(overrides[GLOBAL_KEY]),
  });
  for (const role of SUBAGENT_ROLE_NAMES) {
    items.push({
      value: role,
      label: role,
      description: describeOverride(overrides[role]),
    });
  }
  // Footer affordances.
  items.push({
    value: SENTINEL_RESET_ALL,
    label: "── reset all overrides ──",
    description: undefined,
  });
  items.push({
    value: SENTINEL_CANCEL,
    label: "── cancel ──",
    description: undefined,
  });
  return items;
}

export function buildModelItems(models: PiModel[]): SelectItem[] {
  const items: SelectItem[] = [];
  // Sentinels first so they're reachable without scrolling on long lists.
  items.push({
    value: SENTINEL_PI_DEFAULT,
    label: "── use Pi default (clear override) ──",
    description: undefined,
  });
  items.push({
    value: SENTINEL_CUSTOM,
    label: "── type a custom model id ──",
    description:
      "for models not in `pi --list-models` (e.g. custom providers pending API-key resolution)",
  });
  items.push({
    value: SENTINEL_CANCEL,
    label: "── cancel ──",
    description: undefined,
  });
  // Subscription providers first (Pi handles them via OAuth), then
  // alphabetical. Within each provider, the order Pi returned.
  const subscriptionProviders = new Set(["anthropic", "github-copilot", "openai"]);
  const byProvider = new Map<string, PiModel[]>();
  for (const m of models) {
    const arr = byProvider.get(m.provider) ?? [];
    arr.push(m);
    byProvider.set(m.provider, arr);
  }
  const sortedProviders = [...byProvider.keys()].sort((a, b) => {
    const aSub = subscriptionProviders.has(a) ? 0 : 1;
    const bSub = subscriptionProviders.has(b) ? 0 : 1;
    if (aSub !== bSub) return aSub - bSub;
    return a.localeCompare(b);
  });
  for (const provider of sortedProviders) {
    const list = byProvider.get(provider) ?? [];
    for (const m of list) {
      items.push({
        value: encodeModelValue(provider, m.model),
        label: m.model,
        description: describeModel(m),
      });
    }
  }
  return items;
}

export function encodeModelValue(provider: string, model: string): string {
  return `${provider}${MODEL_VALUE_SEP}${model}`;
}

export function parseModelValue(value: string): ModelChoice | undefined {
  const i = value.indexOf(MODEL_VALUE_SEP);
  if (i < 0) return undefined;
  const provider = value.slice(0, i);
  const model = value.slice(i + 1);
  if (!provider || !model) return undefined;
  return { provider, model };
}

function describeOverride(c: ModelChoice | undefined): string | undefined {
  if (!c) return "(falls through to default)";
  return `→ ${formatChoiceForNotify(c)}`;
}

function describeModel(m: PiModel): string {
  const tags = [m.provider];
  if (m.context) tags.push(m.context);
  if (m.thinking === "yes") tags.push("thinks");
  return tags.join(" · ");
}

// =============================================================================
// Custom-model entry (fallback when the desired model isn't in --list-models)
// =============================================================================

async function promptCustomModel(ctx: ExtensionCommandContext): Promise<ModelChoice | undefined> {
  const typedModel = await ctx.ui.input(
    "Type a model id",
    "vendor/model OR just the model name (for custom providers, set provider below)",
  );
  if (!typedModel || typedModel.trim().length === 0) return undefined;
  const typedProvider = await ctx.ui.input(
    "Provider name (optional)",
    "leave blank for built-in providers; required for custom OpenAI-compatible endpoints",
  );
  const provider = typedProvider?.trim();
  return provider && provider.length > 0
    ? { provider, model: typedModel.trim() }
    : { model: typedModel.trim() };
}

// =============================================================================
// Formatting helpers (kept as before)
// =============================================================================

function formatChoiceForNotify(c: ModelChoice): string {
  return c.provider ? `${c.provider} · ${c.model}` : c.model;
}

/** Re-export used by ensemble-debug for status rendering. */
export function currentResolution() {
  return SUBAGENT_ROLE_NAMES.map((role) => ({ role, choice: resolveModel(role) }));
}
