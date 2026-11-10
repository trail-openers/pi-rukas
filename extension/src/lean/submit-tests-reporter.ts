/**
 * Companion Pi extension loaded into the work-lean `specify` child.
 *
 * Registers two tools, each with a TypeBox-validated schema. The adversary
 * calls `submit_tests` ONCE per acceptance criterion it wrote a test file for,
 * and — only when the requirement lever is on — `submit_requirements` ONCE with
 * the numbered list of requirements it derived from the issue and the code it
 * read. Pi validates the params in-process and the parent extracts every call
 * from the child's session `tool_use` events (`submit-tests-extract.ts`,
 * `requirements.ts`).
 *
 * No execution logic: the tools exist so the model has a structured way to name
 * the files it claims are the acceptance tests for a criterion, and the
 * requirements it claims to have covered. The parent does the trusting — it
 * re-reads the spec, drops a row whose criterion is not a `verify: "test"`
 * criterion, rejects a path that escapes the worktree, checks the file exists,
 * and finally PROVES each kept file red on the base commit. Acknowledging the
 * call is enough here.
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

interface SubmitRequirementsInput {
  requirements: unknown[];
}

/**
 * One requirement item, as the child sends it. The parent re-validates every
 * field (`extractRequirements`): this schema is the child's first guard against
 * a call it will regret, not the step's evidence.
 */
const RequirementItem = Type.Object({
  id: Type.String({ description: 'The item id, numbered from R1: "R1", "R2", …' }),
  kind: Type.Union([Type.Literal("behaviour"), Type.Literal("edge"), Type.Literal("preserved")], {
    description:
      '"behaviour" = what the change must do; "edge" = an input form or interaction it must handle; "preserved" = a behaviour the code already has and the change must keep.',
  }),
  text: Type.String({ description: "One line on the requirement, in your own words." }),
  testFiles: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "The test file(s) that cover it. For behaviour and edge items these are files YOU WROTE and submitted under a criterion; for a preserved item this is an EXISTING test file of the repository that already passes.",
  }),
  note: Type.Optional(
    Type.String({
      description:
        'For a preserved item with no existing green test: one line on why, e.g. "no test covers the default-value path".',
    }),
  ),
});

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

  // The requirement list. Registered unconditionally rather than behind the
  // switch: the reporter is one static file handed to the child with
  // `--extension`, and the prompt is what asks for a call — a child whose step
  // never mentions the tool does not reach for it. The parent judges the list
  // only when the switch is on.
  pi.registerTool({
    name: "submit_requirements",
    label: "Submit Requirements",
    description:
      // As in `submit_tests`, one complete call is spelled out: Pi's schema
      // validation names a single missing key per rejection, and an item that
      // omits `kind` costs the child a turn to discover that.
      'Report the numbered list of requirements the issue implies, each mapped to the test(s) that cover it. Call ONCE, with every item. Every item MUST carry id ("R1", "R2", …), kind ("behaviour" | "edge" | "preserved"), text and a non-empty testFiles array. Example: {"requirements": [{"id": "R1", "kind": "edge", "text": "an empty list is accepted", "testFiles": ["tests/AC1-empty.test.ts"]}]}.',
    parameters: Type.Object({
      requirements: Type.Array(RequirementItem, {
        minItems: 1,
        description: "Every requirement you identified, numbered from R1. At least one.",
      }),
    }),
    async execute(_id, raw) {
      const params = raw as SubmitRequirementsInput;
      const items = Array.isArray(params.requirements) ? params.requirements : [];
      return {
        content: [
          {
            type: "text",
            text: `recorded ${items.length} requirement item(s)`,
          },
        ],
        details: { requirements: items },
      };
    },
  });
}
