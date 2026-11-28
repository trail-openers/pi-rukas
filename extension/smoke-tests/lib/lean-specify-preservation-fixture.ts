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

import type { WorkConfig } from "../../src/lean/config.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { type RunResult, configWith, makeRepo, put, runSpecify } from "./lean-specify-fixture.ts";

/** The runner template every case configures: `sh <file>`, so the shell grades the script itself. */
export const RUNNER = "sh {file}";
export const CONFIG = configWith({ fast: "true", test: RUNNER });

/** The roster-breaker's tell: what the offender prints when its file joins the tree. */
export const ROSTER_DAMAGE = "work/roster-3.sh: not ok - a project test broke";

/**
 * The project's own gate: green on the base's tree, red the moment a breaker file sits in the worktree. It
 * reads, so it is a verdict and not a command the shell could not start.
 */
export const BREAKING_FREEZE_CHECK =
  `if grep -lq "${ROSTER_DAMAGE}" tests/*.test.sh 2>/dev/null; then ` +
  `echo "${ROSTER_DAMAGE}" >&2; exit 1; fi; exit 0`;

/** A config that runs that gate as the run's freeze check. */
export const CONFIG_WITH_FREEZE_CHECK = configWith({
  fast: "true",
  test: RUNNER,
  freezeCheck: BREAKING_FREEZE_CHECK,
});

/** The five criteria both panel rows carried. */
export const PANEL_IDS = ["AC1", "AC2", "AC3", "AC4", "AC5"];

/** The five criteria exactly as the off-arm capture wrote them — one spec, both arms. */
export const PANEL_CRITERIA = [
  { id: "AC1", text: "retries a transient failure twice", verify: "test" as const },
  { id: "AC2", text: "gives up on a non-transient error", verify: "test" as const },
  { id: "AC3", text: "times out a hung request", verify: "test" as const },
  { id: "AC4", text: "keeps the existing retry budget readable", verify: "test" as const },
  { id: "AC5", text: "logs one line per attempt", verify: "test" as const },
];

/** The issue body: five `verify: "test"` criteria, the contract the step freezes against. */
export const PANEL_BODY = `\`\`\`pi-spec v1
${JSON.stringify(
  {
    problem: "The retry helper gives up on the first transient failure.",
    size: "S",
    criteria: PANEL_CRITERIA,
  },
  null,
  2,
)}
\`\`\``;

/** A file that fails on the base and names itself — what the red proof counts as red. */
export function redFile(): string {
  return ["#!/bin/sh", 'echo "not ok - $(basename "$0")" 1>&2', "exit 1", ""].join("\n");
}

/** A file that passes on the base: the shape a coverage gap and a preservation file share. */
export function greenFile(): string {
  return ["#!/bin/sh", 'echo "ok - $(basename "$0")"', "exit 0", ""].join("\n");
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
  for (let i = 0; i < ROSTER_FILES; i++)
    files[`project-tests/roster-${String(i)}.sh`] = "#!/bin/sh\nexit 0\n";
  return makeRepo(files);
}

/** One row of a panel submission; also the shape the off-arm capture drives. */
export interface PanelRow {
  id: string;
  /** What the child writes at that criterion's path; absent writes nothing for it. */
  script?: string;
  /** The `preserves` value the child puts on the call, if any. */
  preserves?: unknown;
  /** Give this row its own path, so one criterion can carry two files. */
  rel?: string;
}

export interface PanelOpts {
  issue: number;
  /** The config the step runs under; the roster cases add a freeze check. */
  config?: WorkConfig;
  /** The rows the child submits, in order. */
  rows: PanelRow[];
  /** Body to show the child; defaults to the five-criterion panel spec. */
  specBody?: string;
  /** Where the kickoff prompt the step built is recorded, so a case can assert its text. */
  prompts?: string[];
}

/** Drive the real specify step with a child that writes these rows and declares them. */
export async function runPanel(opts: PanelOpts): Promise<RunResult & { outcome?: Outcome }> {
  const { repoRoot, baseSha } = panelRepo();
  const toolUses = opts.rows.map((row) => ({
    name: "submit_tests",
    arguments: {
      criterionId: row.id,
      testFiles: [row.rel ?? testRel(row.id)],
      ...(row.preserves === undefined ? {} : { preserves: row.preserves }),
    },
  }));
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: opts.issue,
    config: opts.config ?? CONFIG,
    specBody: opts.specBody ?? PANEL_BODY,
    prompts: opts.prompts,
    writes: (wt) => {
      for (const row of opts.rows)
        if (row.script !== undefined) put(wt, row.rel ?? testRel(row.id), row.script);
    },
    toolUses,
  });
  return r;
}

/** The four-red / one-green rows of the panel, with `preservedId` declared when given. */
export function panelRows(greenId: string, preservedId?: string): PanelRow[] {
  return PANEL_IDS.map((id) => ({
    id,
    script: id === greenId ? greenFile() : redFile(),
    ...(id === preservedId ? { preserves: true } : {}),
  }));
}
