/**
 * Companion Pi extension loaded into the work-lean `build` child.
 *
 * Registers a single `report_blocked` tool with a TypeBox-validated schema, so a
 * builder that finds its frozen tests CANNOT all pass together has a machine action to
 * take instead of probing until the turn ceiling kills it. The child calls it once,
 * naming each conflicting file and why; Pi validates the params in-process and the
 * parent extracts every call from the child's `tool_use` events
 * (`build-blocked-extract.ts`).
 *
 * No execution logic, and no trust: the parent does the judging — it requires every
 * named path to be in the run's frozen map and RUNS those frozen tests itself on the
 * child's tree, honouring the report only when at least one comes back red. Loaded via
 * `pi --no-skills --extension <path>` — the two flags this step's dispatch site passes in
 * `extraArgs` (`build-dispatch.ts`) on top of the shared child argv, which itself carries
 * `--no-extensions` (`buildChildArgs`); never auto-discovered.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Where this file lives: the extension's source directory, so `--extension` gets
 * the real path and `statReporterPath` can preflight it before the spawn.
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
      // validation names a single missing key per rejection.
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
