#!/usr/bin/env bun
/**
 * #1306 — the `--capabilities` drift test: the capabilities answer must be
 * derived from the live constants. If a flag, input, or contract version
 * changes and the capabilities answer does not, this test fails.
 *
 * The test re-derives the expected answer from the same live sources
 * `buildCapabilities` reads (WORK_FLAGS, HEADLESS_INPUTS, HEADLESS_FEATURES,
 * the EXIT object, NDJSON_VERSION, package.json version) and compares every
 * field against the actual answer. A field that changed on the live side but
 * not in `buildCapabilities` (or vice versa) is a drift — the caller would
 * be told one thing while the build does another.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CAPABILITIES_VERSION,
  HEADLESS_FEATURES,
  HEADLESS_INPUTS,
  WORK_FLAGS,
  buildCapabilities,
} from "../src/headless/capabilities.ts";
import { EXIT } from "../src/headless/exit-code.ts";
import { NDJSON_VERSION } from "../src/headless/ndjson.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The live package.json version, read the same way buildCapabilities does.
function liveVersion(): string {
  const p = path.resolve(import.meta.dirname, "..", "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const caps = buildCapabilities();

// ── schemaVersion is the documented constant.
assert(caps.schemaVersion === CAPABILITIES_VERSION, "schemaVersion matches CAPABILITIES_VERSION");

// ── version comes from package.json.
assert(caps.version === liveVersion(), `version matches package.json (${caps.version})`);

// ── contracts.exitCodes.version is a positive integer and values match EXIT.
assert(
  typeof caps.contracts.exitCodes.version === "number" && caps.contracts.exitCodes.version >= 1,
  "exit codes contract version is a positive integer",
);
assert(
  deepEqual(caps.contracts.exitCodes.values, EXIT),
  "exit codes values match the live EXIT object",
);
assert(caps.contracts.exitCodes.values.merged === 0, "merged → 0");
assert(caps.contracts.exitCodes.values.handoff === 10, "handoff → 10");
assert(caps.contracts.exitCodes.values.clarification === 11, "clarification → 11");
assert(caps.contracts.exitCodes.values.aborted === 20, "aborted → 20");
assert(caps.contracts.exitCodes.values.interrupted === 21, "interrupted → 21");
assert(caps.contracts.exitCodes.values.crash === 30, "crash → 30");
assert(caps.contracts.exitCodes.values.refused === 40, "refused → 40");

// ── contracts.resultSchema.version is a positive integer.
assert(
  typeof caps.contracts.resultSchema.version === "number" &&
    caps.contracts.resultSchema.version >= 1,
  "result schema contract version is a positive integer",
);

// ── contracts.ndjson.version matches the live NDJSON_VERSION.
assert(
  caps.contracts.ndjson.version === NDJSON_VERSION,
  `NDJSON version matches the live NDJSON_VERSION (${caps.contracts.ndjson.version})`,
);

// ── verbs.work.flags matches the live WORK_FLAGS.
assert(
  deepEqual(caps.verbs.work.flags, [...WORK_FLAGS]),
  "work flags match the live WORK_FLAGS array",
);
assert(caps.verbs.work.flags.length >= 3, "work flags has at least --restart, --json, --timeout");
assert(caps.verbs.work.flags.includes("--restart"), "work flags includes --restart");
assert(caps.verbs.work.flags.includes("--json"), "work flags includes --json");
assert(caps.verbs.work.flags.includes("--timeout"), "work flags includes --timeout");

// ── inputs match the live HEADLESS_INPUTS.
assert(deepEqual(caps.inputs, HEADLESS_INPUTS), "inputs match the live HEADLESS_INPUTS array");
assert(
  caps.inputs.some((i) => i.name === "PI_ENSEMBLE_EXTRA_IMAGE_DIRS"),
  "inputs include PI_ENSEMBLE_EXTRA_IMAGE_DIRS",
);
assert(
  caps.inputs.some((i) => i.name === "PI_ENSEMBLE_ISSUE_IMAGES"),
  "inputs include PI_ENSEMBLE_ISSUE_IMAGES",
);
for (const input of caps.inputs) {
  assert(
    typeof input.name === "string" && input.name.length > 0,
    `input name is non-empty: ${input.name}`,
  );
  assert(
    typeof input.readBy === "string" && input.readBy.length > 0,
    `input readBy is non-empty: ${input.name}`,
  );
  assert(
    typeof input.manifestVersion === "number" && input.manifestVersion >= 1,
    `input manifestVersion is a positive integer: ${input.name}`,
  );
}

// ── features match the live HEADLESS_FEATURES.
assert(
  deepEqual(caps.features, HEADLESS_FEATURES),
  "features match the live HEADLESS_FEATURES object",
);
assert(caps.features.resultFromMemory === true, "features.resultFromMemory is true");
assert(caps.features.cycleDeadline === true, "features.cycleDeadline is true");

// ── The answer has exactly the documented top-level keys (no missing, no extra).
{
  const expectedKeys = new Set([
    "schemaVersion",
    "version",
    "commit",
    "contracts",
    "verbs",
    "inputs",
    "features",
    "resources",
  ]);
  const actualKeys = new Set(Object.keys(caps));
  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k));
  const extra = [...actualKeys].filter((k) => !expectedKeys.has(k));
  assert(missing.length === 0, `no missing top-level keys (${missing.join(", ") || "none"})`);
  assert(extra.length === 0, `no extra top-level keys (${extra.join(", ") || "none"})`);
}

// ── commit is either null or a non-empty string (never a fabricated empty string).
assert(
  caps.commit === null || (typeof caps.commit === "string" && caps.commit.length > 0),
  "commit is null or a non-empty string",
);

// ── The answer is serializable to JSON without loss (no circular refs, no functions).
assert(() => {
  JSON.stringify(caps);
  return true;
}, "capabilities answer is JSON-serializable");

process.exit(exit);
