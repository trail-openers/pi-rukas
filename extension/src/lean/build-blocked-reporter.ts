/**
 * Companion Pi extension loaded into the work-lean `build` child.
 *
 * Registers a single `report_blocked` tool with a TypeBox-validated schema, so
 * a builder that finds its frozen tests CANNOT all pass together has a machine
 * action to take instead of probing until the turn ceiling kills it. The child
 * calls it once, naming each conflicting file and why; Pi validates the params
 * in-process and the parent extracts every call from the child's session
 * `tool_use` events (`build-blocked-extract.ts`).
 *
 * No execution logic, and no trust: the tool exists only so the model has a
 * structured way to say "these assertions are mutually unsatisfiable". The
 * parent does the judging — it requires every named path to be in the run's
 * frozen map and then RUNS those frozen tests itself on the child's tree, and
 * honours the report only when at least one comes back red. A child that names
 * a file it imagined, or one whose tests pass, ends nothing.
 *
 * Loaded via `pi --no-skills --extension <path-to-this-file>` from
 * `build-dispatch.ts`; never auto-discovered. Mirrors `submit-tests-reporter.ts`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Where this file lives. Built like `SUBMIT_TESTS_REPORTER_PATH` — the source
 * directory of the extension — so `--extension` gets the real path and
 * `statReporterPath` can preflight it before the child is spawned.
 * `fileURLToPath(import.meta.url)` rather than `__dirname`, which jiti does not
 * define for an ES module.
 */
export const BLOCKED_REPORTER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "build-blocked-reporter.ts",
);

interface BlockedInput {
  conflicts: Array<{ path: string; reason: string }>;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_blocked",
    label: "Report Unsatisfiable Frozen Tests",
    description:
      // Both keys are spelled out with one complete call because Pi's schema
      // validation names a single missing key per rejection: a model that sends
      // only `conflicts` is told about the shape of an entry, one wasted turn
      // each.
      'Report that the frozen acceptance tests cannot ALL pass together, naming each conflicting file and why. Call this ONCE, then stop — do not keep probing. Every entry MUST carry both path (a frozen test file, relative to the working tree, never absolute) and reason (one or two sentences on the contradiction). Example: {"conflicts": [{"path": "tests/AC1-identity.test.ts", "reason": "case 2 requires the array to stay mutable while case 3 mutates it in place and asserts the record is untouched"}]}.',
    parameters: Type.Object({
      conflicts: Type.Array(
        Type.Object({
          path: Type.String({
            description: "A frozen test file path, relative to the working tree.",
          }),
          reason: Type.String({
            description: "Why this file's assertions cannot hold at the same time as the others'.",
          }),
        }),
        { minItems: 1, maxItems: 32 },
      ),
    }),
    async execute(_id, raw) {
      const params = raw as BlockedInput;
      const conflicts = Array.isArray(params.conflicts) ? params.conflicts : [];
      return {
        content: [
          {
            type: "text",
            text: `recorded ${conflicts.length} conflicting frozen test file(s)`,
          },
        ],
        details: { conflicts },
      };
    },
  });
}
