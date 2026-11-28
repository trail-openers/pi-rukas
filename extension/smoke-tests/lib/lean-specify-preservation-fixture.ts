/**
 * lib/lean-specify-preservation-fixture — the panel-shaped driver the preservation tests share.
 *
 * Both panel rows are the same shape and must not each keep a private copy of it: a spec of five
 * `verify: "test"` criteria, a fake child that writes one file per criterion and declares them with
 * `submit_tests`, and a roster of the project's own tests. What differs between the shapes is only WHICH
 * criterion is green at the base and which rows carry `preserves: true` — so this module takes that as
 * input and everything else is shared, driven through the real `specify` step with only the model faked.
 *
 * The child writes files whose content the case chooses, so a case decides for itself whether a criterion
 * is red or green on the base: `redFile` exits non-zero and names its own path (the red proof's own
 * condition), `greenFile` exits 0.
 */

import type { Outcome } from "../../src/lean/state.ts";
import {
  type RunResult,
  configWith,
  makeRepo,
  put,
  runSpecify,
} from "./lean-specify-fixture.ts";

/** The runner template every case configures: `sh <file>`, so the shell grades the script itself. */
export const RUNNER = "sh {file}";
export const CONFIG = configWith({ fast: "true", test: RUNNER });

/** The five criteria both panel rows carried. */
export const PANEL_IDS = ["AC1", "AC2", "AC3", "AC4", "AC5"];

/** The issue body: five `verify: "test"` criteria, the contract the step freezes against. */
export const PANEL_BODY = `\`\`\`pi-spec v1
${JSON.stringify(
  {
    problem: "The retry helper gives up on the first transient failure.",
    size: "S",
    criteria: PANEL_IDS.map((id) => ({ id, text: `the retry helper does AC${id.slice(2)}`, verify: "test" })),
  },
  null,
  2,
)}
\`\`\``;

/** A file that fails on the base and names itself — what the red proof counts as red. */
export function redFile(): string {
  return ['#!/bin/sh', 'echo "not ok - $(basename "$0")" 1>&2', "exit 1", ""].join("\n");
}

/** A file that passes on the base: the shape a coverage gap and a preservation file share. */
export function greenFile(): string {
  return ['#!/bin/sh', 'echo "ok - $(basename "$0")"', "exit 0", ""].join("\n");
}

/** The path the child writes for one criterion, named to carry the id as the boundary asks. */
export function testRel(id: string): string {
  return `tests/${id}-retry.test.sh`;
}

/** How many of the project's own tests the fixture repo's base holds — the panel's roster size. */
export const ROSTER_FILES = 35;

/** The base tree: a source file plus the project's own roster of test files. */
export function panelRepo(): { repoRoot: string; baseSha: string } {
  const files: Record<string, string> = { "src/retry.ts": "export const retry = () => {};\n" };
  for (let i = 0; i < ROSTER_FILES; i++) files[`project-tests/roster-${String(i)}.sh`] = "#!/bin/sh\nexit 0\n";
  return makeRepo(files);
}

/** One row of the child's submission: the criterion, its file, and whether it declared itself preserved. */
export interface ChildRow {
  id: string;
  /** What the child writes at that criterion's path; absent writes nothing for it. */
  script?: string;
  /** The `preserves` value the child puts on the call, if any. */
  preserves?: unknown;
}

export interface PanelOpts {
  issue: number;
  /** The rows the child submits, in order. */
  rows: ChildRow[];
  /** Body to show the child; defaults to the five-criterion panel spec. */
  specBody?: string;
  /** Where the kickoff prompt the step built is recorded, so a case can assert its text. */
  prompts?: string[];
}

/** Drive the real specify step with a child that writes these rows and declares them. */
export async function runPanel(opts: PanelOpts): Promise<RunResult & { outcome?: Outcome }> {
  console.log("XXX", opts.issue, "rows:", JSON.stringify(opts.rows.map((r) => [r.id, r.preserves])), "greenScript:", JSON.stringify((opts.rows ?? []).map((r) => [r.id, r.script === undefined ? "none" : (r.script.includes("exit 1") ? "red" : "green")])));
  const { repoRoot, baseSha } = panelRepo();
  console.log("YYY switch=", String((await import("../../src/lean-specify-preserves-switch.ts")).leanSpecifyPreservesEnabled()), "raw=", JSON.stringify(opts.rows.map((r) => [r.id, r.preserves])), "extract=", JSON.stringify((await import("../../src/lean/submit-tests-extract.ts")).extractSubmitTests(opts.rows.map((r) => ({ name: "submit_tests", arguments: { criterionId: r.id, testFiles: [testRel(r.id)], ...(r.preserves === undefined ? {} : { preserves: r.preserves }) } }))).rows.map((x) => [x.criterionId, x.preserves])));
  const toolUses = opts.rows.map((row) => ({
    name: "submit_tests",
    arguments: {
      criterionId: row.id,
      testFiles: [testRel(row.id)],
      ...(row.preserves === undefined ? {} : { preserves: row.preserves }),
    },
  }));
  if (!Array.isArray(opts.rows)) throw new Error("runPanel: rows is not an array");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: opts.issue,
    config: CONFIG,
    specBody: opts.specBody ?? PANEL_BODY,
    prompts: opts.prompts,
    writes: (wt) => {
      for (const row of opts.rows) if (row.script !== undefined) put(wt, testRel(row.id), row.script);
    },
    toolUses,
  });
  return r;
}

/** The four-red / one-green rows of the panel, with `preservedId` declared when given. */
export function panelRows(greenId: string, preservedId?: string): ChildRow[] {
  return PANEL_IDS.map((id) => ({
    id,
    script: id === greenId ? greenFile() : redFile(),
    ...(id === preservedId ? { preserves: true } : {}),
  }));
}
