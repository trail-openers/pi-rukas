/**
 * provider-env — a run's own endpoint and key for a `models.json` provider,
 * taken from the environment and never written to disk.
 *
 * `PI_ENSEMBLE_BASE_URL_<PROVIDER>` replaces that provider's `baseUrl` (every
 * model of it, the per-model ones included) and `PI_ENSEMBLE_API_KEY_<PROVIDER>`
 * supplies its key, for the life of the process. `<PROVIDER>` is a provider
 * name from `<agent dir>/models.json`, upper-cased with every other character
 * mapped to `_`.
 *
 * The mechanism is Pi's own extension layer: `pi.registerProvider(name,
 * {baseUrl, apiKey})` composes above `models.json` without touching it. The key
 * is registered as the `${PI_ENSEMBLE_API_KEY_<PROVIDER>}` reference, never as
 * its value, so Pi reads it from the environment when it builds each request
 * and the value never passes through this code, a log or a file. A pair left
 * unset registers nothing, so the file stays in charge exactly as before.
 *
 * Registered by the parent extension and by the child-guards companion, so the
 * PM session and every spawned child resolve the provider the same way; the
 * child inherits the two variables with the rest of its environment, so a
 * child's tools and the commands it runs can read the key too.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A provider name as it appears in an env name. */
export const providerEnvId = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/**
 * Pi's agent dir, resolved as Pi's `getAgentDir` does: an empty value is unset
 * and a leading `~` is the home dir. A different reading would look for a
 * `models.json` Pi does not use and drop every override without a word.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) return path.join(os.homedir(), ".pi", "agent");
  if (dir === "~") return os.homedir();
  return dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
}

/** The provider names in Pi's `models.json`; none when it is absent or unreadable. */
export function modelsJsonProviders(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = agentDir(env);
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, "models.json"), "utf8"));
    return Object.keys(parsed?.providers ?? {}).sort();
  } catch {
    return [];
  }
}

/** The overrides `env` asks for, one per provider that has either variable set. */
export function providerOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Array<[string, { baseUrl?: string; apiKey?: string }]> {
  const out: Array<[string, { baseUrl?: string; apiKey?: string }]> = [];
  for (const provider of modelsJsonProviders(env)) {
    const id = providerEnvId(provider);
    const baseUrl = env[`PI_ENSEMBLE_BASE_URL_${id}`]?.trim() || undefined;
    const keyName = `PI_ENSEMBLE_API_KEY_${id}`;
    const apiKey = env[keyName]?.trim() ? `\${${keyName}}` : undefined;
    if (baseUrl || apiKey) out.push([provider, { baseUrl, apiKey }]);
  }
  return out;
}

export function registerProviderEnvOverrides(pi: ExtensionAPI): void {
  for (const [provider, config] of providerOverrides()) pi.registerProvider(provider, config);
}
