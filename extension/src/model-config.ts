import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Persistence for /ensemble-model overrides.
 *
 * Schema evolution: entries used to be plain model-ID strings; now they're
 * `{ provider?, model }` objects so custom OpenAI-compatible providers
 * (vLLM, self-hosted endpoints, etc.) can route subagents correctly. Legacy
 * string entries are still read (normalised to `{ model }` with no provider)
 * and rewritten as objects on the next save. No user-visible migration —
 * `ensemble-models.json` files from older builds keep working.
 */

const CONFIG_PATH_DEFAULT = path.join(os.homedir(), ".pi", "agent", "ensemble-models.json");

/** What we persist per role. `provider` is optional — when omitted, Pi resolves the provider from its own registered config based on the model ID. */
export interface ModelChoice {
  /** Pi provider name as it appears in `~/.pi/agent/models.json` providers map. Omit for built-in compound IDs like `anthropic/claude-sonnet`. */
  provider?: string;
  /** Upstream model ID. For custom providers, this is the vendor model name (e.g. `Qwen/Qwen3.6-35B-A3B-FP8`). For built-ins, the compound `provider/model`. */
  model: string;
}

/** On-disk schema — accepts both legacy strings and the new object form. */
type PersistedEntry = string | ModelChoice;
interface PersistedConfig {
  models?: Record<string, PersistedEntry>;
}

let inMemory: Record<string, ModelChoice> = {};
let loaded = false;
const SPECIAL_DEFAULT_KEY = "__all__";

function getConfigPath(): string {
  return process.env.PI_ENSEMBLE_MODELS_CONFIG ?? CONFIG_PATH_DEFAULT;
}

function normaliseEntry(entry: PersistedEntry): ModelChoice | undefined {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (trimmed.length === 0) return undefined;
    return { model: trimmed };
  }
  if (typeof entry === "object" && entry !== null && typeof entry.model === "string") {
    const model = entry.model.trim();
    if (model.length === 0) return undefined;
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    return provider.length > 0 ? { provider, model } : { model };
  }
  return undefined;
}

/** Load persisted overrides from disk into the in-memory map. Idempotent. */
export async function loadOverrides(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(getConfigPath(), "utf8");
    const cfg = JSON.parse(raw) as PersistedConfig;
    inMemory = {};
    for (const [role, entry] of Object.entries(cfg.models ?? {})) {
      const choice = normaliseEntry(entry);
      if (choice) inMemory[role] = choice;
    }
  } catch {
    inMemory = {};
  }
}

/**
 * Test-only — reset the `loaded` flag so `loadOverrides` re-reads disk.
 * Required when tests mutate the on-disk file directly to validate the
 * legacy-schema migration path; without this, the module-level cache
 * masks the new contents.
 */
export function resetForTesting(): void {
  loaded = false;
  inMemory = {};
}

async function persist(): Promise<void> {
  const file = getConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body: PersistedConfig = { models: { ...inMemory } };
  await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export interface OverrideLookup {
  choice: ModelChoice | undefined;
  key?: string;
}

/**
 * Look up an override for `role`. Falls back to the special "all-subagents"
 * default key, which acts as an in-session/in-file equivalent of
 * `PI_ENSEMBLE_SUBAGENT_MODEL` / `PI_ENSEMBLE_SUBAGENT_PROVIDER`.
 */
export function getOverride(role: string): OverrideLookup {
  const direct = inMemory[role];
  if (direct) return { choice: direct, key: role };
  const fallback = inMemory[SPECIAL_DEFAULT_KEY];
  if (fallback) return { choice: fallback, key: SPECIAL_DEFAULT_KEY };
  return { choice: undefined };
}

export async function setOverride(role: string, choice: ModelChoice): Promise<void> {
  const normalised = normaliseEntry(choice);
  if (!normalised) return;
  inMemory[role] = normalised;
  await persist();
}

export async function setGlobalOverride(choice: ModelChoice): Promise<void> {
  const normalised = normaliseEntry(choice);
  if (!normalised) return;
  inMemory[SPECIAL_DEFAULT_KEY] = normalised;
  await persist();
}

export async function clearOverride(role: string): Promise<void> {
  delete inMemory[role];
  await persist();
}

export async function clearAllOverrides(): Promise<void> {
  inMemory = {};
  await persist();
}

export function getAllOverrides(): Record<string, ModelChoice> {
  return { ...inMemory };
}

export const GLOBAL_KEY = SPECIAL_DEFAULT_KEY;
