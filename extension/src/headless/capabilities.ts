/**
 * headless/capabilities — the `--capabilities` answer (issue #1306): one
 * versioned JSON object describing what THIS build of pi-rukas-headless
 * supports, so a caller (tehas) can check before starting a cycle and fail
 * closed on an unknown name instead of discovering a gap mid-run.
 *
 *   pi-rukas-headless --capabilities   (prints the object to stdout, exit 0)
 *
 * It starts no cycle, reads no repository and makes no network call. The
 * shape is derived from the same live constants the runner itself reads:
 *
 *   - `version`    — package.json `version` (extension/package.json)
 *   - `commit`     — baked by install.sh / the image into
 *                    `<repoRoot>/.pi/pi-rukas-commit`; absent when the
 *                    checkout has no baked marker (e.g. a bare worktree)
 *   - `contracts`  — exit codes (exit-code.ts), the `--json` result schema
 *                    (result.ts), NDJSON progress (ndjson.ts)
 *   - `inputs`     — the env-var inputs this build reads, by name
 *   - `features`   — named features a caller may depend on
 *   - `resources`  — the host budget and the parallelism limits a cycle
 *                    started now would run with (#1325, resource-budget.ts)
 *
 * The contract-version constants live on the contract modules themselves
 * (exit-code.ts, result.ts, ndjson.ts); this module reads whatever they export.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { type ResourceReport, resourceReport } from "../resource-budget.ts";
import { EXIT, EXIT_CODE_VERSION } from "./exit-code.ts";
import { NDJSON_VERSION } from "./ndjson.ts";
import { RESULT_SCHEMA_VERSION } from "./result.ts";

/**
 * The version of the capabilities object itself. Bump on any change to the
 * answer's shape (added/removed top-level fields); the caller's drift test
 * (#1306) reads this and re-derives the answer from the live constants.
 */
export const CAPABILITIES_VERSION = 2 as const;

/** The flags `work` accepts, in the order the parser accepts them. */
export const WORK_FLAGS = ["--restart", "--json", "--timeout"] as const;

/**
 * The inputs this build reads, by env-var name, with the steps each reaches.
 * Derived from the live sources: `PI_ENSEMBLE_ISSUE_IMAGES` gates
 * `loadIssueImages` (work-driver-issue-images.ts) and `PI_ENSEMBLE_EXTRA_IMAGE_DIRS`
 * names the directories `manifestIssue` reads from.
 */
export const HEADLESS_INPUTS: { name: string; readBy: string; manifestVersion: number }[] = [
  {
    name: "PI_ENSEMBLE_EXTRA_IMAGE_DIRS",
    readBy: "explore,plan",
    manifestVersion: 1,
  },
  {
    name: "PI_ENSEMBLE_ISSUE_IMAGES",
    readBy: "explore,plan",
    manifestVersion: 1,
  },
];

/** The features a caller may depend on, as named booleans. */
export const HEADLESS_FEATURES = {
  /** #1189 — the result is taken from the driver's in-memory state, not the state file. */
  resultFromMemory: true,
  /** #1238 — a cycle that hits its deadline parks with a handoff (not a kill). */
  cycleDeadline: true,
} as const;

export interface Capabilities {
  schemaVersion: typeof CAPABILITIES_VERSION;
  version: string;
  commit: string | null;
  contracts: {
    exitCodes: { version: number; values: typeof EXIT };
    resultSchema: { version: number };
    ndjson: { version: number };
  };
  verbs: {
    work: { flags: (typeof WORK_FLAGS)[number][] };
  };
  inputs: typeof HEADLESS_INPUTS;
  features: typeof HEADLESS_FEATURES;
  /** #1325 — read from this host when the answer is built. */
  resources: ResourceReport;
}

/**
 * Read the version baked into extension/package.json. `null` when the file is
 * missing or unreadable (the caller reports it as-is; the schema does not
 * require it to be non-null).
 */
export function readBuildVersion(pkgJsonPath?: string): string {
  const p = pkgJsonPath ?? path.resolve(import.meta.dirname, "..", "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Read the commit baked into `<repoRoot>/.pi/pi-rukas-commit` by install.sh /
 * the image build. Returns `null` when the file is missing or empty — a
 * checkout without a baked marker (a bare worktree, a dev tree) reports
 * `null`, not a fabricated string.
 */
export function readBakedCommit(repoRoot: string): string | null {
  try {
    const raw = readFileSync(path.join(repoRoot, ".pi", "pi-rukas-commit"), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Build the full capabilities object. Pure given the inputs: no network, no
 * spawn, no driver. `repoRoot` is used only for the baked-commit lookup;
 * pass any path when the caller has no repo root (the commit is `null`).
 */
export function buildCapabilities(repoRoot?: string): Capabilities {
  return {
    schemaVersion: CAPABILITIES_VERSION,
    version: readBuildVersion(),
    commit: repoRoot !== undefined ? readBakedCommit(repoRoot) : null,
    contracts: {
      exitCodes: { version: EXIT_CODE_VERSION, values: EXIT },
      resultSchema: { version: RESULT_SCHEMA_VERSION },
      ndjson: { version: NDJSON_VERSION },
    },
    verbs: {
      work: { flags: [...WORK_FLAGS] },
    },
    inputs: HEADLESS_INPUTS,
    features: HEADLESS_FEATURES,
    resources: resourceReport(),
  };
}
