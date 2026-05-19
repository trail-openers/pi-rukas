import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CONFIG_PATH_DEFAULT = path.join(os.homedir(), ".pi", "agent", "ensemble-models.json");

interface PersistedConfig {
  /** Per-role overrides. Key "default" is the global subagent fallback. */
  models?: Record<string, string>;
}

let inMemory: Record<string, string> = {};
let loaded = false;
const SPECIAL_DEFAULT_KEY = "__all__";

function getConfigPath(): string {
  return process.env.PI_ENSEMBLE_MODELS_CONFIG ?? CONFIG_PATH_DEFAULT;
}

/** Load persisted overrides from disk into the in-memory map. Idempotent. */
export async function loadOverrides(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(getConfigPath(), "utf8");
    const cfg = JSON.parse(raw) as PersistedConfig;
    inMemory = { ...(cfg.models ?? {}) };
  } catch {
    inMemory = {};
  }
}

async function persist(): Promise<void> {
  const file = getConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body: PersistedConfig = { models: inMemory };
  await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export interface OverrideLookup {
  model: string | undefined;
  key?: string;
}

/**
 * Look up an override for `role`. Falls back to the special "all-subagents"
 * default key, which acts as an in-session/in-file equivalent of
 * PI_ENSEMBLE_SUBAGENT_MODEL.
 */
export function getOverride(role: string): OverrideLookup {
  const direct = inMemory[role];
  if (direct && direct.trim().length > 0) return { model: direct, key: role };
  const fallback = inMemory[SPECIAL_DEFAULT_KEY];
  if (fallback && fallback.trim().length > 0) return { model: fallback, key: SPECIAL_DEFAULT_KEY };
  return { model: undefined };
}

export async function setOverride(role: string, model: string): Promise<void> {
  inMemory[role] = model.trim();
  await persist();
}

export async function setGlobalOverride(model: string): Promise<void> {
  inMemory[SPECIAL_DEFAULT_KEY] = model.trim();
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

export function getAllOverrides(): Record<string, string> {
  return { ...inMemory };
}

export const GLOBAL_KEY = SPECIAL_DEFAULT_KEY;
