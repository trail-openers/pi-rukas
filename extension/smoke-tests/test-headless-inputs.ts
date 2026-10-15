#!/usr/bin/env bun
/**
 * #1326 — the `--capabilities` input inventory must list every
 * `PI_ENSEMBLE_*` input `extension/src/` reads, and nothing it no longer reads.
 *
 * A host fails closed on a name the build does not list, so a read missing
 * from HEADLESS_INPUTS is an input the host can never set safely, and a stale
 * entry is a promise the build does not keep. The scan finds:
 *
 *   - property reads: `process.env.PI_ENSEMBLE_X`, `env.PI_ENSEMBLE_X`, `childEnv?.…`
 *   - index reads:    `env["PI_ENSEMBLE_X"]`
 *   - name literals:  `"PI_ENSEMBLE_X"`, and template prefixes `` `PI_ENSEMBLE_X_${…}` ``
 *     (the per-role and per-seam families, read through a computed key)
 *
 * Comment lines are skipped, so a jsdoc mention is not a read. The scan is
 * also run against a planted fixture to prove it catches an unlisted read
 * (a gate never observed to fail is worthless). A few defaults are checked
 * against the live reader functions, so a changed default cannot drift.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { adversarialPhaseBudgetMs } from "../src/adversarial-retry.ts";
import { COMMENT_RETENTION_PATHS } from "../src/comment-retention.ts";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { HEADLESS_FILES, HEADLESS_INPUTS, type HostInput } from "../src/headless/inputs.ts";
import { lensRoundCap } from "../src/lens-round-cap.ts";
import { planCacheTtlMs } from "../src/plan-investigation-cache.ts";
import { transcriptRetentionDays } from "../src/runs-retention.ts";
import { slowThresholds } from "../src/slow-notice.ts";
import { spawnCap } from "../src/spawn-semaphore.ts";
import {
  inactivityTimeoutMs,
  spawnBackstopMs,
  toolInactivityTimeoutMs,
} from "../src/spawn-support.ts";
import { capKillGraceMs } from "../src/spawn-token-budget.ts";
import { integrationVerifyTimeoutMs } from "../src/work-driver-commit-title.ts";
import {
  burstThresholdSeconds,
  transientRetryBackoffMs,
} from "../src/work-driver-failure-taxonomy.ts";
import { resolvedParallelGroups } from "../src/work-driver-grouping.ts";
import { handoffPostBackoffMs } from "../src/work-driver-handoff-post-retry.ts";
import { handoffDispatchTimeoutMs } from "../src/work-driver-handoff.ts";
import { NET_GIT_TIMEOUT_DEFAULT_MS } from "../src/work-driver-net-git.ts";
import { planDispatchTimeoutMs } from "../src/work-driver-plan-helpers.ts";
import { maxWorkstreams } from "../src/work-driver-plan-workstreams.ts";
import { stepNoticeThresholdMs } from "../src/work-driver-step-notice.ts";
import { testDeleteTolerance, verifyTimeoutMs } from "../src/work-driver-verify-develop-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const READS = [
  /[A-Za-z]*[eE]nv\??\.(PI_ENSEMBLE_[A-Z0-9_]+)/g,
  /env\[\s*["'`](PI_ENSEMBLE_[A-Z0-9_]+)["'`]\s*\]/g,
  /["'`](PI_ENSEMBLE_[A-Z0-9_]+)(?=["'`]|\$\{)/g,
];
const COMMENT = /^\s*(\*|\/\*|\/\/)/;

/** Every PI_ENSEMBLE_* name read under `root`, mapped to one file that reads it. */
function scan(root: string): Map<string, string> {
  const found = new Map<string, string>();
  // The inventory itself is excluded: a name written there must not list itself.
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== path.join("headless", "inputs.ts"),
  );
  for (const rel of files) {
    const lines = readFileSync(path.join(root, rel), "utf8").split("\n");
    for (const line of lines) {
      if (COMMENT.test(line)) continue;
      for (const re of READS) {
        for (const m of line.matchAll(re)) {
          const name = m[1] as string;
          if (!found.has(name)) found.set(name, rel);
        }
      }
    }
  }
  return found;
}

/** `PI_ENSEMBLE_MODEL_<ROLE>` → `PI_ENSEMBLE_MODEL_`; a plain name → undefined. */
function familyPrefix(entry: HostInput): string | undefined {
  const i = entry.name.indexOf("<");
  return i < 0 ? undefined : entry.name.slice(0, i);
}

/** Whether a scanned name is covered by an entry (exactly, or as a family member/prefix). */
function covers(entry: HostInput, name: string): boolean {
  const prefix = familyPrefix(entry);
  if (prefix === undefined) return entry.name === name;
  return name.startsWith(prefix) || `${name}_` === prefix;
}

function uncovered(found: Map<string, string>, inputs: readonly HostInput[]): string[] {
  return [...found.keys()].filter((n) => !inputs.some((e) => covers(e, n)));
}

const srcRoot = path.resolve(import.meta.dirname, "..", "src");
const found = scan(srcRoot);
assert(found.size > 50, `scan found the src/ env reads (${found.size} names)`);
assert(found.has("PI_ENSEMBLE_MAX_WORKSTREAMS"), "scan sees a process.env property read");
assert(found.has("PI_ENSEMBLE_GIT_NET_TIMEOUT_MS"), "scan sees a name read through a constant");
assert(found.has("PI_ENSEMBLE_MODEL_"), "scan sees a template-prefix (family) read");

// ── Every read is listed.
const missing = uncovered(found, HEADLESS_INPUTS);
assert(
  missing.length === 0,
  `every PI_ENSEMBLE_* read in src/ is listed in HEADLESS_INPUTS${
    missing.length ? ` — missing: ${missing.map((n) => `${n} (${found.get(n)})`).join(", ")}` : ""
  }`,
);

// ── Every entry is still read.
const stale = HEADLESS_INPUTS.filter((e) => ![...found.keys()].some((n) => covers(e, n)));
assert(
  stale.length === 0,
  `every HEADLESS_INPUTS entry is read in src/${stale.length ? ` — stale: ${stale.map((e) => e.name).join(", ")}` : ""}`,
);

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

// ── The planted fixture: an unlisted read is caught, a comment mention is not.
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-inputs-scan-"));
  try {
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(
      path.join(dir, "sub", "planted.ts"),
      [
        "// process.env.PI_ENSEMBLE_ONLY_IN_A_COMMENT",
        "const a = process.env.PI_ENSEMBLE_PLANTED_UNLISTED;",
        'const b = env["PI_ENSEMBLE_PLANTED_INDEXED"];',
        "const c = `PI_ENSEMBLE_MODEL_${role}`;",
        "const d = process.env.PI_ENSEMBLE_VERIFY;",
      ].join("\n"),
    );
    const planted = uncovered(scan(dir), HEADLESS_INPUTS).sort();
    assert(
      JSON.stringify(planted) ===
        JSON.stringify(["PI_ENSEMBLE_PLANTED_INDEXED", "PI_ENSEMBLE_PLANTED_UNLISTED"]),
      `the scan flags exactly the planted unlisted reads (${planted.join(", ")})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Listed defaults agree with the live readers (env unset).
function defaultOf(name: string): HostInput["default"] | undefined {
  return HEADLESS_INPUTS.find((e) => e.name === name)?.default;
}
const LIVE: [string, () => unknown][] = [
  ["PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS", adversarialPhaseBudgetMs],
  ["PI_ENSEMBLE_CAP_KILL_GRACE_MS", capKillGraceMs],
  ["PI_ENSEMBLE_COMMENT_RETENTION_PATHS", () => COMMENT_RETENTION_PATHS.join(",")],
  ["PI_ENSEMBLE_GIT_NET_TIMEOUT_MS", () => NET_GIT_TIMEOUT_DEFAULT_MS],
  ["PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS", handoffPostBackoffMs],
  ["PI_ENSEMBLE_HANDOFF_TIMEOUT_MS", handoffDispatchTimeoutMs],
  ["PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS", inactivityTimeoutMs],
  ["PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS", integrationVerifyTimeoutMs],
  ["PI_ENSEMBLE_LENS_ROUND_CAP", () => lensRoundCap()],
  ["PI_ENSEMBLE_MAX_WORKSTREAMS", maxWorkstreams],
  ["PI_ENSEMBLE_PARALLEL_GROUPS", resolvedParallelGroups],
  ["PI_ENSEMBLE_PLAN_CACHE_TTL_MS", planCacheTtlMs],
  ["PI_ENSEMBLE_PLAN_TIMEOUT_MS", planDispatchTimeoutMs],
  ["PI_ENSEMBLE_RATE_LIMIT_BURST_MAX_S", burstThresholdSeconds],
  ["PI_ENSEMBLE_SLOW_NOTICE_MS", () => slowThresholds().ms],
  ["PI_ENSEMBLE_SLOW_NOTICE_TOKENS", () => slowThresholds().tokens],
  ["PI_ENSEMBLE_SLOW_NOTICE_TURNS", () => slowThresholds().turns],
  ["PI_ENSEMBLE_SPAWN_CAP", spawnCap],
  ["PI_ENSEMBLE_SPAWN_TIMEOUT_MS", spawnBackstopMs],
  ["PI_ENSEMBLE_STEP_NOTICE_MS", stepNoticeThresholdMs],
  ["PI_ENSEMBLE_TEST_DELETE_TOLERANCE", testDeleteTolerance],
  ["PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS", toolInactivityTimeoutMs],
  ["PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS", transcriptRetentionDays],
  ["PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS", transientRetryBackoffMs],
  ["PI_ENSEMBLE_VERIFY_TIMEOUT_MS", verifyTimeoutMs],
];
// The switch that would override a dimension's own default is cleared too.
const SWITCHES: Record<string, string> = {
  PI_ENSEMBLE_PARALLEL_GROUPS: "PI_ENSEMBLE_PARALLEL_WORK",
  PI_ENSEMBLE_SLOW_NOTICE_MS: "PI_ENSEMBLE_SLOW_NOTICE",
  PI_ENSEMBLE_SLOW_NOTICE_TOKENS: "PI_ENSEMBLE_SLOW_NOTICE",
  PI_ENSEMBLE_SLOW_NOTICE_TURNS: "PI_ENSEMBLE_SLOW_NOTICE",
};
for (const [name, read] of LIVE) {
  const keys = [name, SWITCHES[name]].filter((k): k is string => k !== undefined);
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) delete process.env[k];
  try {
    const live = read();
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

// ── .pi/* files: listed, and each one named in src/.
{
  const srcText = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(path.join(srcRoot, f), "utf8"))
    .join("\n");
  for (const f of HEADLESS_FILES) {
    const base = path.basename(f.path);
    assert(
      srcText.includes(f.path) || srcText.includes(`".pi", "${base}"`),
      `${f.path} is read in src/`,
    );
  }
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

process.exit(exit);
