/**
 * Smoke-test helper: the env-read scan behind `test-headless-inputs.ts`'s
 * inventory check. Split out so that gate stays under the AGENTS.md §12 size
 * cap — `lib/pi-read-sites.ts` is the same seam for the `.pi/*` half.
 *
 * The scan finds, per source file:
 *
 *   - property reads:   `process.env.PI_ENSEMBLE_X`, `env.PI_ENSEMBLE_X`, `childEnv?.…`
 *   - index reads:      `env["PI_ENSEMBLE_X"]`
 *   - destructuring:    `const { PI_ENSEMBLE_X } = process.env`
 *   - name literals:    `"PI_ENSEMBLE_X"` (a name read through a constant)
 *   - dynamic keys:     `` `PI_ENSEMBLE_X_${…}` ``, `"PI_ENSEMBLE_X_" + …` and a
 *                       trailing-`_` literal. Each must be on DYNAMIC_KEYS, which
 *                       maps it to the family entry it reads; any other dynamic
 *                       key fails, because the scan cannot see what it reads.
 *
 * A comment line states rather than reads, so it is never a site.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { HostInput } from "../../src/headless/inputs.ts";

/** A comment line states rather than reads, so it is never a site. */
const COMMENT = /^\s*(\*|\/\*|\/\/)/;
const NAME = "PI_ENSEMBLE_[A-Za-z0-9_]*";
const EXACT = [
  new RegExp(`[A-Za-z]*[eE]nv\\??\\.(${NAME})`, "g"),
  new RegExp(`env\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "g"),
  new RegExp(`["'\`](${NAME})["'\`](?!\\s*\\+)`, "g"),
];
const DYNAMIC = [
  new RegExp(`\`(${NAME})\\$\\{`, "g"),
  new RegExp(`["'\`](${NAME})["'\`]\\s*\\+`, "g"),
];
const DESTRUCTURE = /\{([^}]*)\}\s*=\s*(?:process\.env|[A-Za-z]*[eE]nv)\b/g;

/**
 * The approved dynamic keys: the key text in source → the family entry it
 * reads. `envKey("PI_ENSEMBLE_DECISION_MODE", seam)` appends `_<SEAM>`.
 */
export const DYNAMIC_KEYS: Record<string, string> = {
  PI_ENSEMBLE_DECISION_BUDGET: "PI_ENSEMBLE_DECISION_BUDGET_<SEAM>",
  PI_ENSEMBLE_DECISION_MODE: "PI_ENSEMBLE_DECISION_MODE_<SEAM>",
  PI_ENSEMBLE_DECISION_TIMEOUT_MS: "PI_ENSEMBLE_DECISION_TIMEOUT_MS_<SEAM>",
  PI_ENSEMBLE_MODEL_: "PI_ENSEMBLE_MODEL_<ROLE>",
  PI_ENSEMBLE_MODEL_LENS_: "PI_ENSEMBLE_MODEL_LENS_<LENS>",
  PI_ENSEMBLE_PROVIDER_: "PI_ENSEMBLE_PROVIDER_<ROLE>",
  PI_ENSEMBLE_PROVIDER_LENS_: "PI_ENSEMBLE_PROVIDER_LENS_<LENS>",
  PI_ENSEMBLE_TOKEN_BUDGET_: "PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>",
};

export interface Scan {
  /** Literal names read, → one file reading each. */
  exact: Map<string, string>;
  /** Dynamic key texts, → one file using each. */
  dynamic: Map<string, string>;
}

/** The reads in one file's text, accumulated into `out`. */
export function scanText(text: string, rel: string, out: Scan): void {
  const put = (m: Map<string, string>, name: string) => {
    if (!m.has(name)) m.set(name, rel);
  };
  for (const line of text.split("\n")) {
    if (COMMENT.test(line)) continue;
    const dynamicHere = new Set<string>();
    for (const re of DYNAMIC) {
      for (const m of line.matchAll(re)) {
        dynamicHere.add(m[1] as string);
        put(out.dynamic, m[1] as string);
      }
    }
    for (const re of EXACT) {
      for (const m of line.matchAll(re)) {
        const name = m[1] as string;
        if (dynamicHere.has(name)) continue;
        // A trailing `_` or a bare prefix is a key built at runtime.
        if (name.endsWith("_") || name in DYNAMIC_KEYS) put(out.dynamic, name);
        else put(out.exact, name);
      }
    }
    for (const m of line.matchAll(DESTRUCTURE)) {
      for (const n of (m[1] as string).matchAll(new RegExp(`\\b(${NAME})\\b`, "g"))) {
        put(out.exact, n[1] as string);
      }
    }
  }
}

/** Every PI_ENSEMBLE_* read under `root`. */
export function scan(root: string): Scan {
  const out: Scan = { exact: new Map(), dynamic: new Map() };
  // The inventory itself is excluded: a name written there must not list itself.
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== path.join("headless", "inputs.ts"),
  );
  for (const rel of files) scanText(readFileSync(path.join(root, rel), "utf8"), rel, out);
  return out;
}

/** Whether `name` is the entry, or a member of its family (prefix + a listed id). */
export function covers(entry: HostInput, name: string): boolean {
  const i = entry.name.indexOf("<");
  if (i < 0) return entry.name === name;
  const prefix = entry.name.slice(0, i);
  if (entry.members) return entry.members.some((m) => name === prefix + m);
  return new RegExp(`^${prefix}[A-Z][A-Z0-9_]*$`).test(name);
}

/** The problems a scan shows against an inventory: unlisted reads and unapproved dynamic keys. */
export function problems(found: Scan, inputs: readonly HostInput[]): string[] {
  const out: string[] = [];
  for (const [n, f] of found.exact) {
    if (!inputs.some((e) => covers(e, n))) out.push(`unlisted ${n} (${f})`);
  }
  for (const [k, f] of found.dynamic) {
    const family = DYNAMIC_KEYS[k];
    if (family === undefined) out.push(`unapproved dynamic key ${k} (${f})`);
    else if (!inputs.some((e) => e.name === family))
      out.push(`dynamic key ${k} → unlisted ${family}`);
  }
  return out;
}
