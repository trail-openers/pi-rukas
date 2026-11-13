#!/usr/bin/env bun
/**
 * #1326 — the `--capabilities` input inventory must list every
 * `PI_ENSEMBLE_*` input `extension/src/` reads, and nothing it no longer reads.
 *
 * A host fails closed on a name the build does not list, so a read missing
 * from HEADLESS_INPUTS is an input the host can never set safely, and a stale
 * entry is a promise the build does not keep. The scan finds:
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
 * A family entry (`PI_ENSEMBLE_MODEL_<ROLE>`) covers a literal name only when
 * the name is its prefix plus one of its `members` (or, for an entry without
 * members, any upper-case id). An entry read only by the sandbox wrapper
 * (lib/wrapper-env-reads.ts) is not stale; test-headless-inputs-wrapper.ts
 * checks that side. Comment lines
 * are skipped. Every rule is also run against a planted fixture, so each is
 * observed to fail (a gate never observed to fail is worthless). Numeric,
 * list and boolean defaults of the inputs named in LIVE are checked against
 * their live reader functions; the rest are checked by review only.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { HEADLESS_FILES, HEADLESS_INPUTS, type HostInput } from "../src/headless/inputs.ts";
import { readSites } from "./lib/pi-read-sites.ts";
import { LIVE_INPUTS, SWITCHES } from "./lib/headless-live-inputs.ts";
import { wrapperEnvReads } from "./lib/wrapper-env-reads.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

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
const DYNAMIC_KEYS: Record<string, string> = {
  PI_ENSEMBLE_DECISION_BUDGET: "PI_ENSEMBLE_DECISION_BUDGET_<SEAM>",
  PI_ENSEMBLE_DECISION_MODE: "PI_ENSEMBLE_DECISION_MODE_<SEAM>",
  PI_ENSEMBLE_DECISION_TIMEOUT_MS: "PI_ENSEMBLE_DECISION_TIMEOUT_MS_<SEAM>",
  PI_ENSEMBLE_MODEL_: "PI_ENSEMBLE_MODEL_<ROLE>",
  PI_ENSEMBLE_MODEL_LENS_: "PI_ENSEMBLE_MODEL_LENS_<LENS>",
  PI_ENSEMBLE_PROVIDER_: "PI_ENSEMBLE_PROVIDER_<ROLE>",
  PI_ENSEMBLE_PROVIDER_LENS_: "PI_ENSEMBLE_PROVIDER_LENS_<LENS>",
  PI_ENSEMBLE_TOKEN_BUDGET_: "PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>",
};

interface Scan {
  /** Literal names read, → one file reading each. */
  exact: Map<string, string>;
  /** Dynamic key texts, → one file using each. */
  dynamic: Map<string, string>;
}

function scanText(text: string, rel: string, out: Scan): void {
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
function scan(root: string): Scan {
  const out: Scan = { exact: new Map(), dynamic: new Map() };
  // The inventory itself is excluded: a name written there must not list itself.
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== path.join("headless", "inputs.ts"),
  );
  for (const rel of files) scanText(readFileSync(path.join(root, rel), "utf8"), rel, out);
  return out;
}

/** Whether `name` is the entry, or a member of its family (prefix + a listed id). */
function covers(entry: HostInput, name: string): boolean {
  const i = entry.name.indexOf("<");
  if (i < 0) return entry.name === name;
  const prefix = entry.name.slice(0, i);
  if (entry.members) return entry.members.some((m) => name === prefix + m);
  return new RegExp(`^${prefix}[A-Z][A-Z0-9_]*$`).test(name);
}

/** The problems a scan shows against an inventory: unlisted reads and unapproved dynamic keys. */
function problems(found: Scan, inputs: readonly HostInput[]): string[] {
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

const srcRoot = path.resolve(import.meta.dirname, "..", "src");
const found = scan(srcRoot);
assert(found.exact.size > 50, `scan found the src/ env reads (${found.exact.size} names)`);
assert(found.exact.has("PI_ENSEMBLE_MAX_WORKSTREAMS"), "scan sees a process.env property read");
assert(
  found.exact.has("PI_ENSEMBLE_GIT_NET_TIMEOUT_MS"),
  "scan sees a name read through a constant",
);
assert(found.dynamic.has("PI_ENSEMBLE_MODEL_"), "scan sees a dynamic family key");

// ── Every read is listed, and every dynamic key is approved.
const found1 = problems(found, HEADLESS_INPUTS);
assert(
  found1.length === 0,
  `every PI_ENSEMBLE_* read in src/ is listed in HEADLESS_INPUTS${found1.length ? ` — ${found1.join(", ")}` : ""}`,
);

// ── Every entry, and every approved dynamic key, is still used.
{
  const wrapper = wrapperEnvReads();
  const stale = HEADLESS_INPUTS.filter(
    (e) =>
      !wrapper.has(e.name) &&
      ![...found.exact.keys()].some((n) => covers(e, n)) &&
      ![...found.dynamic.keys()].some((k) => DYNAMIC_KEYS[k] === e.name),
  );
  assert(
    stale.length === 0,
    `every HEADLESS_INPUTS entry is read in src/ or by the wrapper${stale.length ? ` — stale: ${stale.map((e) => e.name).join(", ")}` : ""}`,
  );
  const unused = Object.keys(DYNAMIC_KEYS).filter((k) => !found.dynamic.has(k));
  assert(unused.length === 0, `every approved dynamic key is used (${unused.join(", ")})`);
}

// ── Entries are well-formed, unique and sorted.
{
  const names = HEADLESS_INPUTS.map((e) => e.name);
  assert(new Set(names).size === names.length, "input names are unique");
  const sorted = [...names].sort((a, b) =>
    a.replace(/_/g, " ").localeCompare(b.replace(/_/g, " ")),
  );
  assert(JSON.stringify(sorted) === JSON.stringify(names), "inputs are sorted by name");
  const numeric = ["integer", "number", "duration-ms"];
  const malformed = HEADLESS_INPUTS.filter((e) => {
    if (!e.name.startsWith("PI_ENSEMBLE_")) return true;
    if (e.type === "enum" && !(e.values && e.values.length > 0)) return true;
    if (e.type === "list" && typeof e.separator !== "string") return true;
    if (e.default === null) return false;
    if (e.type === "boolean") return typeof e.default !== "boolean";
    if (numeric.includes(e.type)) return typeof e.default !== "number";
    return typeof e.default !== "string";
  });
  assert(
    malformed.length === 0,
    `every input is well-formed for its type${malformed.length ? ` — ${malformed.map((e) => e.name).join(", ")}` : ""}`,
  );
}

// ── The planted fixture: each rule is observed to fail.
{
  const planted: Scan = { exact: new Map(), dynamic: new Map() };
  scanText(
    [
      "// process.env.PI_ENSEMBLE_ONLY_IN_A_COMMENT",
      "const a = process.env.PI_ENSEMBLE_PLANTED_UNLISTED;",
      'const b = env["PI_ENSEMBLE_PLANTED_INDEXED"];',
      "const { PI_ENSEMBLE_PLANTED_DESTRUCTURED, PI_ENSEMBLE_VERIFY: v } = process.env;",
      "const c = `PI_ENSEMBLE_MODEL_${role}`;",
      "const d = process.env.PI_ENSEMBLE_VERIFY;",
      "const e = `PI_ENSEMBLE_${x}`;",
      'const f = "PI_ENSEMBLE_PLANTED_" + x;',
      // A bare family prefix is not a member: the old startsWith check accepted it.
      'const g = process.env["PI_ENSEMBLE_MODEL_"];',
      "const h = process.env.PI_ENSEMBLE_MODEL_DEVELOPER;",
      "const i = process.env.PI_ENSEMBLE_MODEL_developer;",
      // Not a role: a typo the family's members refuse.
      "const j = process.env.PI_ENSEMBLE_MODEL_REVIEWER;",
    ].join("\n"),
    "planted.ts",
    planted,
  );
  const got = problems(planted, HEADLESS_INPUTS).sort();
  const want = [
    "unapproved dynamic key PI_ENSEMBLE_ (planted.ts)",
    "unapproved dynamic key PI_ENSEMBLE_PLANTED_ (planted.ts)",
    "unlisted PI_ENSEMBLE_MODEL_REVIEWER (planted.ts)",
    "unlisted PI_ENSEMBLE_MODEL_developer (planted.ts)",
    "unlisted PI_ENSEMBLE_PLANTED_DESTRUCTURED (planted.ts)",
    "unlisted PI_ENSEMBLE_PLANTED_INDEXED (planted.ts)",
    "unlisted PI_ENSEMBLE_PLANTED_UNLISTED (planted.ts)",
  ];
  assert(
    JSON.stringify(got) === JSON.stringify(want),
    `the scan flags exactly the planted problems (${got.join("; ")})`,
  );
  assert(!planted.exact.has("PI_ENSEMBLE_ONLY_IN_A_COMMENT"), "a comment mention is not a read");
  assert(
    planted.dynamic.has("PI_ENSEMBLE_MODEL_") && !planted.exact.has("PI_ENSEMBLE_MODEL_"),
    "a bare family prefix is a dynamic key, never a member",
  );
  const narrow = { ...HEADLESS_INPUTS[0], name: "PI_ENSEMBLE_MODEL_<ROLE>" } as HostInput;
  assert(
    covers(narrow, "PI_ENSEMBLE_MODEL_DEVELOPER") && !covers(narrow, "PI_ENSEMBLE_MODELS_CONFIG"),
    "a family matches its prefix plus an id, nothing looser",
  );
}

// ── Listed defaults agree with the live readers (env unset).
// The roster itself — every name, its live reader, and the master switch that
// would override its default — lives in lib/headless-live-inputs.ts, split
// along the same seam as lib/pi-read-sites.ts and lib/verify-tier-pin.ts so
// this gate stays under the AGENTS.md §12 size cap. A name listed there but
// absent from HEADLESS_INPUTS fails the assertion below as loudly as one
// listed here.
function defaultOf(name: string): HostInput["default"] | undefined {
  return HEADLESS_INPUTS.find((e) => e.name === name)?.default;
}
for (const [name, read] of LIVE_INPUTS) {
  const keys = [name, SWITCHES[name]].filter((k): k is string => k !== undefined);
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) delete process.env[k];
  try {
    // #1509 — awaited: the per-tier resolvers read a `.pi/*-timeout-ms` file
    // and are therefore async. Every existing reader returns a plain value,
    // which `await` passes through unchanged, so the sync entries are
    // unaffected.
    const live = await read();
    assert(
      live === defaultOf(name),
      `${name} default ${defaultOf(name)} matches the reader (${live})`,
    );
  } finally {
    keys.forEach((k, n) => {
      if (saved[n] !== undefined) process.env[k] = saved[n];
    });
  }
}

// ── .pi/* files: each listed file is actually read, not just named.
// The scan itself lives in lib/pi-read-sites.ts (§12 size cap) and is observed
// to fail by the two planted fixtures below.
{
  const files = new Map(
    readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => [f, readFileSync(path.join(srcRoot, f), "utf8")] as const),
  );
  for (const f of HEADLESS_FILES) {
    // A git-blob read is a read: `lean/config.ts` loads `.pi/work.json` with
    // `git show <baseSha>:.pi/work.json` through the injected exec seam
    // (#406's doctrine-read rule — config that decides what a run may do is
    // never read from the working tree), so that entry is judged against the
    // git reader. Every other file keeps the filesystem rule untouched.
    const sites = readSites(files, f.path, f.path === ".pi/work.json");
    assert(sites.length > 0, `${f.path} is read in src/ (${sites.join(", ") || "no read site"})`);
  }
  const fixture = new Map([
    ["hint.ts", 'const msg = "add or fix `.pi/planted-hint`";\nconst p = ".pi/planted-hint";'],
    ["read.ts", 'const p = path.join(root, ".pi", "planted-read");\nconst t = readFileSync(p);'],
  ]);
  assert(
    readSites(fixture, ".pi/planted-hint").length === 0,
    "a path named only in a message is not a read",
  );
  assert(
    readSites(fixture, ".pi/planted-read").length === 1,
    "a joined path followed by a read is a read",
  );
  assert(
    !HEADLESS_FILES.some((f) => f.path.startsWith(".pi/work-state")),
    "the state file is not listed as an input",
  );
}

// ── The capabilities answer carries both lists.
{
  const caps = buildCapabilities();
  assert(caps.inputs === HEADLESS_INPUTS, "capabilities.inputs is HEADLESS_INPUTS");
  assert(caps.files === HEADLESS_FILES, "capabilities.files is HEADLESS_FILES");
}

// Each switch's truth table and docs row are pinned by its own file (e.g.
// test-lean-issue-prose-switch.ts); the live defaults are pinned by the loop
// above over lib/headless-live-inputs.ts's roster.

process.exit(exit);
