/**
 * headless/capabilities — the `--capabilities` answer (issue #1306): one
 * versioned JSON object describing what THIS build of pi-rukas-headless
 * supports, so a caller (orchard) can check before starting a cycle and fail
 * closed on an unknown name instead of discovering a gap mid-run.
 *
 *   pi-rukas-headless --capabilities   (prints the object to stdout, exit 0)
 *
 * It starts no cycle, reads no project repository and makes no network call. The
 * shape is derived from the same live constants the runner itself reads:
 *
 *   - `version`    — package.json `version` (extension/package.json)
 *   - `commit`     — the commit the build was made from (build.ts): the
 *                    image's baked marker, else the install checkout's HEAD,
 *                    else null
 *   - `contracts`  — exit codes (exit-code.ts), the `--json` result schema
 *                    with its `cap` vocabulary (result.ts, caps.ts), NDJSON
 *                    progress with its stable kind subset (ndjson.ts)
 *   - `inputs`     — every `PI_ENSEMBLE_*` env input this build reads, with
 *                    type, default and scope (inputs.ts, #1326)
 *   - `files`      — the `.pi/*` project files a cycle reads (inputs.ts)
 *   - `features`   — named features a caller may depend on
 *
 * The contract-version constants live on the contract modules themselves
 * (exit-code.ts, result.ts, ndjson.ts); this module reads whatever they export.
 */

import path from "node:path";
import { INSTALL_ROOT, readBuildCommit, readBuildVersion } from "./build.ts";
import { capVocabulary } from "./caps.ts";
import { EXIT, EXIT_CODE_VERSION } from "./exit-code.ts";
import { HEADLESS_FILES, HEADLESS_INPUTS } from "./inputs.ts";
import { NDJSON_STABLE_FIELDS, NDJSON_STABLE_VERSION, NDJSON_VERSION } from "./ndjson.ts";
import { RESULT_SCHEMA_VERSION } from "./result.ts";

/**
 * The version of the capabilities object itself. Bump on any change to the
 * answer's shape (added/removed top-level fields); the caller's drift test
 * (#1306) reads this and re-derives the answer from the live constants.
 * v2 (#1326): every input with type/default/scope, and `files`.
 */
export const CAPABILITIES_VERSION = 2 as const;

/** The flags `work` accepts, in the order the parser accepts them. */
export const WORK_FLAGS = ["--restart", "--json", "--timeout"] as const;

export { HEADLESS_FILES, HEADLESS_INPUTS } from "./inputs.ts";
export { readBakedCommit, readBuildVersion } from "./build.ts";

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
    resultSchema: { version: number; caps: ReturnType<typeof capVocabulary> };
    ndjson: {
      version: number;
      stable: { version: number; kinds: typeof NDJSON_STABLE_FIELDS };
    };
  };
  verbs: {
    work: { flags: (typeof WORK_FLAGS)[number][] };
  };
  inputs: typeof HEADLESS_INPUTS;
  files: typeof HEADLESS_FILES;
  features: typeof HEADLESS_FEATURES;
}

/**
 * Build the full capabilities object. No network and no driver; the only
 * process it may start is one `git rev-parse` in pi-rukas's own install root
 * (build.ts), never in the project. `installRoot` is a test seam.
 */
export function buildCapabilities(installRoot: string = INSTALL_ROOT): Capabilities {
  return {
    schemaVersion: CAPABILITIES_VERSION,
    version: readBuildVersion(path.join(installRoot, "extension", "package.json")),
    commit: readBuildCommit(installRoot),
    contracts: {
      exitCodes: { version: EXIT_CODE_VERSION, values: EXIT },
      resultSchema: { version: RESULT_SCHEMA_VERSION, caps: capVocabulary() },
      ndjson: {
        version: NDJSON_VERSION,
        stable: { version: NDJSON_STABLE_VERSION, kinds: NDJSON_STABLE_FIELDS },
      },
    },
    verbs: {
      work: { flags: [...WORK_FLAGS] },
    },
    inputs: HEADLESS_INPUTS,
    files: HEADLESS_FILES,
    features: HEADLESS_FEATURES,
  };
}
