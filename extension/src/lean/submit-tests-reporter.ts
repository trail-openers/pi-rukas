/**
 * Companion Pi extension loaded into the work-lean `specify` child.
 *
 * Registers a single `submit_tests` tool with a TypeBox-validated schema. The
 * adversary calls it ONCE per acceptance criterion it wrote a test file for;
 * Pi validates the params in-process and the parent extracts every call from
 * the child's session `tool_use` events (`submit-tests-extract.ts`).
 *
 * No execution logic: the tool exists so the model has a structured way to
 * name the files it claims are the acceptance tests for a criterion. The
 * parent does the trusting — it re-reads the spec, drops a row whose criterion
 * is not a `verify: "test"` criterion, rejects a path that escapes the
 * worktree, checks the file exists, and finally PROVES each kept file red on
 * the base commit. Acknowledging the call is enough here.
 *
 * Loaded via `pi --no-extensions --extension <path-to-this-file>` from
 * specify.ts; never auto-discovered. Mirrors lens-reporter.ts exactly.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Where this file lives. Built like `LENS_REPORTER_PATH` in lens-review.ts —
 * the source directory of the extension — so `--extension` gets the real
 * path and `statReporterPath` can preflight it before the child is spawned.
 * `fileURLToPath(import.meta.url)` rather than `__dirname`, which jiti does
 * not define for an ES module.
 */
export const SUBMIT_TESTS_REPORTER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "submit-tests-reporter.ts",
);

interface SubmitTestsInput {
  criterionId: string;
  testFiles: string[];
  note?: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "submit_tests",
    label: "Submit Acceptance Tests",
    description:
      // The required set is spelled out with one complete call because Pi's
      // schema validation names a single missing key per rejection: a model
      // that sends only `testFiles` is told about `criterionId`, one wasted
      // turn each.
      'Report the acceptance test file(s) you wrote for ONE criterion. Call once per criterion — do not batch criteria into one call, and do not report a file you did not write. Every call MUST carry both required fields — criterionId and a non-empty testFiles array — or it is rejected and nothing is recorded; note is optional. Paths are relative to the working tree, never absolute. Example: {"criterionId": "AC1", "testFiles": ["tests/AC1-retry.test.ts"], "note": "fails on the missing retry loop"}.',
    parameters: Type.Object({
      criterionId: Type.String({
        description: 'The criterion id this test covers, e.g. "AC1".',
      }),
      testFiles: Type.Array(Type.String(), {
        minItems: 1,
        description:
          "Test file paths relative to the working tree. At least one; every file must exist.",
      }),
      note: Type.Optional(
        Type.String({
          description: "One line on what the test asserts and why it fails today.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as SubmitTestsInput;
      const files = Array.isArray(params.testFiles) ? params.testFiles : [];
      return {
        content: [
          {
            type: "text",
            text: `recorded ${files.length} test file(s) for ${params.criterionId}`,
          },
        ],
        details: { ...params, testFiles: files },
      };
    },
  });
}
