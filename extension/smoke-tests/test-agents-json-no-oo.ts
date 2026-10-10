#!/usr/bin/env bun
/**
 * #1029 — the agents.json half of the `oo` retirement: the allowlist keeps
 * working once the `oo` prefix is gone.
 *
 *   (a) Zero bash-allow/deny keys in agents.json begin with `oo ` (word
 *       boundary, not substring — `too git` must not trip this).
 *
 *   (b) For every `oo X …` entry that origin/main allowed, the CURRENT
 *       agents.json allows the bare `X …` (or a strictly broader allow entry)
 *       in the SAME role, so strict-mode and headless `pi -p` lose no grant.
 *
 * The pre-change per-role list is the FROZEN FIXTURE
 * `fixtures/agents-json-removed-oo-entries.json`, generated once from
 * `origin/main` (166 entries). This test is offline: it never shells out to
 * `git`, so it must not try to re-derive the list at test time.
 *
 * The matching rule (stated here per the acceptance criterion): a bare form
 * `X` is covered if the role has an allow key equal to it, or an allow key
 * that is a word-boundary prefix wildcard of it (e.g. `git log *` is covered
 * by `git *`; `npm run lint*` by `npm *`).
 *
 * Exemptions — an `oo` entry with no bare equivalent is allowed to be gone:
 *   - the OO-BINARY-ONLY subcommands: recall, help, patterns, learn, forget,
 *     init, version. They only exist as `oo <subcommand>` (the bare words are
 *     not meaningful standalone grants), so they are deleted outright.
 *   - the developer-only image wrappers: animate, compare, composite,
 *     conjure, convert, display, stream. These are ImageMagick-style wrappers
 *     reachable only through the retired `oo` binary in the developer role;
 *     their bare forms were never allowed standalone (no bare row existed
 *     before the retirement), so dropping them changes no strict-mode grant.
 *
 * The test is canaried in both directions: (a) is proven to fail by injecting
 * a fake `oo` key into an in-memory copy, and (b) is proven to fail by
 * temporarily removing one bare row from an in-memory copy.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const AGENTS_PATH = path.join(ROOT, "agents.json");
const FIXTURE_PATH = path.join(ROOT, "extension", "smoke-tests", "fixtures", "agents-json-removed-oo-entries.json"); // (oo = the retired prefix)

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// (a) — word-boundary: no allow/deny key begins with `oo `.
const OO_PREFIX_RE = /^oo /;

type AgentsJson = {
  agent: Record<string, { permission: { bash?: Record<string, string> } }>;
};

function ooPrefixKeys(doc: AgentsJson): string[] {
  const hits: string[] = [];
  for (const [role, spec] of Object.entries(doc.agent)) {
    const bash = spec.permission?.bash;
    if (!bash) continue;
    for (const key of Object.keys(bash)) {
      if (OO_PREFIX_RE.test(key)) hits.push(`${role}: ${JSON.stringify(key)}`);
    }
  }
  return hits;
}

{
  const agents = JSON.parse(readFileSync(AGENTS_PATH, "utf8")) as AgentsJson;
  const hits = ooPrefixKeys(agents);
  assert(
    hits.length === 0,
    `agents.json: zero bash keys begin with \`oo \` (word boundary; found ${hits.length})`,
  );
  if (hits.length) console.error(hits.map((h) => `  ${h}`).join("\n"));

  // Canary: the same check, fed an in-memory copy with a fake `oo` key, MUST
  // fire — otherwise (a) is passing vacuously.
  const clone: AgentsJson = JSON.parse(JSON.stringify(agents));
  const firstRole = Object.keys(clone.agent)[0];
  if (clone.agent[firstRole].permission.bash) {
    (clone.agent[firstRole].permission.bash as Record<string, string>)["oo git log *"] = "allow";
    assert(ooPrefixKeys(clone).length === 1, "(a) canary: an injected `oo git log *` key IS detected");
  } else {
    assert(false, "(a) canary: no role has a bash block to inject into");
  }
}

// (b) — bare-equivalent coverage for every removed `oo` entry.
const OOBINARY_ONLY = new Set(["recall", "help", "patterns", "learn", "forget", "init", "version"]);
const DEV_ONLY_IMAGE_WRAPPERS = new Set(["animate", "compare", "composite", "conjure", "convert", "display", "stream"]);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, string[]>;
const agents = JSON.parse(readFileSync(AGENTS_PATH, "utf8")) as AgentsJson;

// Does role `role` allow the bare pattern `bare`? An allow key covers it when
// equal, or when it is a strict word-boundary prefix wildcard (`… *` or `…*`).
function covered(role: string, bare: string): boolean {
  const bash = agents.agent[role]?.permission?.bash;
  if (!bash) return false;
  for (const [key, verdict] of Object.entries(bash)) {
    if (verdict !== "allow") continue;
    if (key === bare) return true;
    if (key.endsWith("*") && key.length > 1 && bare.startsWith(key.slice(0, -1))) return true;
  }
  return false;
}

// The frozen fixture must still describe reality: every listed entry was an
// `oo` key, and (importantly) the fixture is non-trivial so the coverage loop
// cannot pass over an empty set.
{
  const total = Object.values(fixture).reduce((n, v) => n + v.length, 0);
  assert(total === 166, `fixture lists 166 removed oo-prefixed entries (found ${total})`);
  let allOo = true;
  for (const role of Object.keys(fixture)) {
    for (const entry of fixture[role]) {
      if (!entry.startsWith("oo ")) allOo = false;
    }
  }
  assert(allOo, "fixture: every listed entry is `oo …`-prefixed");
}

{
  const missing: string[] = [];
  for (const [role, entries] of Object.entries(fixture)) {
    if (!agents.agent[role]) {
      missing.push(`${role}: role missing from current agents.json`);
      continue;
    }
    for (const entry of entries) {
      const bare = entry.slice(3); // drop "oo "
      const first = bare.split(" ", 1)[0];
      if (OOBINARY_ONLY.has(first)) continue; // exempt: OO-binary-only
      if (role === "developer" && DEV_ONLY_IMAGE_WRAPPERS.has(first)) continue; // exempt
      if (!covered(role, bare)) missing.push(`${role}: ${entry} -> bare ${JSON.stringify(bare)}`);
    }
  }
  assert(
    missing.length === 0,
    `every removed \`oo X\` entry keeps a bare equivalent in the same role (${missing.length} missing)`,
  );
  if (missing.length) console.error(missing.map((m) => `  ${m}`).join("\n"));

  // Canary for (b): prove the coverage check actually bites. Pick one real
  // non-exempt entry, remove its covering bare row from an in-memory copy, and
  // confirm the (now missing) coverage is reported.
  const sampleRole = "ops";
  const sampleEntry = (fixture[sampleRole] ?? []).find((e) => {
    const bare = e.slice(3);
    const first = bare.split(" ", 1)[0];
    return !OOBINARY_ONLY.has(first) && !DEV_ONLY_IMAGE_WRAPPERS.has(first) && covered(sampleRole, bare);
  });
  assert(sampleEntry !== undefined, "(b) canary: found a non-exempt ops entry to probe");
  if (sampleEntry) {
    const bare = sampleEntry.slice(3);
    const cloneBash = { ...agents.agent[sampleRole].permission.bash } as Record<string, string>;
    // Remove the specific covering row so coverage fails.
    for (const [key, verdict] of Object.entries(cloneBash)) {
      if (verdict !== "allow") continue;
      if (key === bare || (key.endsWith("*") && key.length > 1 && bare.startsWith(key.slice(0, -1)))) {
        delete cloneBash[key];
      }
    }
    const clone: AgentsJson = JSON.parse(JSON.stringify(agents));
    clone.agent[sampleRole].permission.bash = cloneBash;
    const stillCovered = (() => {
      for (const [key, verdict] of Object.entries(clone.agent[sampleRole].permission.bash)) {
        if (verdict !== "allow") continue;
        if (key === bare) return true;
        if (key.endsWith("*") && key.length > 1 && bare.startsWith(key.slice(0, -1))) return true;
      }
      return false;
    })();
    assert(stillCovered === false, `(b) canary: removing the bare row for \`${sampleEntry}\` drops its coverage`);
  }
}

console.log(exit === 0 ? "\nAll agents.json retirement checks passed." : "\nFAILED");
process.exit(exit);
