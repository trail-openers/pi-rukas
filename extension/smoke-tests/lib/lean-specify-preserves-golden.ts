/**
 * lib/lean-specify-preserves-golden — the OFF-arm record of the specify preservation declaration.
 *
 * `test-lean-specify-preserves.ts` compares what `PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES=0` produces
 * against `fixtures/lean-state/specify-preserves-off-2668.json`, captured ONCE from `231491a7f8` — the
 * commit this change is based on, whose `submit_tests` schema, specify prompt and specify record have no
 * knowledge of the field. A record re-rendered by the code under test would only prove the module agrees
 * with itself, so the capture script beside this harness is run against a detached worktree of that commit
 * and its output is the committed fixture.
 *
 * What is captured, all of it from the production path with only the model faked:
 *   - `prompt` — the specify kickoff prompt as `specifyPrompt` built it;
 *   - `schema` — the `submit_tests` parameter block the reporter companion registers;
 *   - `gap` / `freeze` — the specify step's own recorded outcome for a child whose file passed on the base,
 *     and for one whose file failed on the base.
 *
 * The capture declares `preserves: true` on the row it submits even though the pre-change tree has no such
 * field: the whole claim is that a pre-change tree IGNORED it, so the off arm must reproduce that tree's
 * record exactly and the on arm must not.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../../src/lean/config.ts";
import { specifyPrompt } from "../../src/lean/specify-prompt.ts";
import { parsePiSpec } from "../../src/lean/spec.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "../../src/lean/submit-tests-reporter.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { configWith, makeRepo, put, runSpecify } from "./lean-specify-fixture.ts";
import {
  PANEL_BODY as PANEL_BODY_FIXTURE,
  PANEL_IDS,
  type PanelRow,
  greenFile,
  panelRepo,
  redFile,
  testRel,
} from "./lean-specify-preservation-fixture.ts";

/** The committed path of the fixture, relative to `smoke-tests/`. */
export const PRESERVES_FIXTURE = "fixtures/lean-state/specify-preserves-off-2668.json";
/** The base commit the capture was taken from — the last one with no `preserves` field. */
export const PRESERVES_BASE_COMMIT = "231491a7f8";
/** The env name the switch reads. */
export const PRESERVES_KNOB = "PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES";

/** The five criteria, read from the ONE spec the panel fixture owns — the capture and the test differ by
 * nothing but the code they run under. */
const FIVE_BODY = PANEL_BODY_FIXTURE;

const REL = "tests/AC4-guard.test.sh";
/** A file that passes on the base: the child's own `preserves: true` is its claim about it. */
const GREEN = '#!/bin/sh\necho "ok - $(basename "$0")"\nexit 0\n';
/** A file that fails on the base and names itself — the ordinary red test. */
const RED = ["#!/bin/sh", 'echo "not ok - $(basename "$0")" 1>&2', "exit 1", ""].join("\n");

/** One specify run's record: the kind, the reason, and every field the step wrote. */
export interface PreservesRunRecord {
  kind: string;
  outcome: unknown;
}

/** What one arm of the switch leaves: the two texts the child is offered, and the two step records. */
export interface PreservesOffRecord {
  prompt: string;
  schema: string;
  gap: PreservesRunRecord;
  freeze: PreservesRunRecord;
  /** The five-criterion panel run: four reds, one green whose row declared itself preserved. */
  panel?: PreservesRunRecord;
}

/**
 * The `submit_tests` parameter block the companion registers, as a string.
 *
 * Read from the companion's own source rather than from a TypeBox value: the companion registers its tool
 * when Pi loads it, and the thing the off arm must reproduce byte for byte is the text the child's schema
 * carried.
 */
export function submitTestsSchemaText(): string {
  const src = readFileSync(SUBMIT_TESTS_REPORTER_PATH, "utf8");
  const start = src.indexOf("parameters: Type.Object({");
  if (start < 0) throw new Error("the submit_tests companion registers no parameter block");
  const end = src.indexOf("async execute(", start);
  if (end < 0) throw new Error("the submit_tests companion's parameter block never closes");
  return src.slice(start, end);
}

/**
 * The companion's parameter block AS AN OFF-ARM TEXT: the conditional spread the switch adds is elided, the
 * way the off arm elides the field at runtime, and the blank line it brought with it goes with it. Read from
 * the current tree's own reporter, so the comparison stays live — the fixture stays the byte-for-byte record
 * the base commit produced, and this is the text the off arm must reproduce from it.
 */
export function offArmSchemaText(): string {
  const on = submitTestsSchemaText();
  const start = on.indexOf("...(leanSpecifyPreservesEnabled()");
  if (start < 0) return on;
  const end = on.indexOf("})", on.indexOf("Type.Optional(Type.Boolean", start));
  if (end < 0) throw new Error("the preserves arm of the parameter block never closes");
  return `${on.slice(0, start)}${on.slice(on.indexOf(")", on.indexOf("{}", end)) + 1)}`.replace(
    /\n\s*,\s*\n/,
    "\n",
  );
}

/** Run the real specify step over a real repo with one declared file, whose content the caller chooses. */
async function driveSpecify(
  issue: number,
  body: string,
  script: string,
): Promise<PreservesRunRecord> {
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const config = configWith({ fast: "true", test: "sh {file}" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue,
    config,
    specBody: body,
    writes: (wt) => put(wt, REL, script),
    toolUses: [
      {
        name: "submit_tests",
        arguments: { criterionId: "AC4", testFiles: [REL], preserves: true },
      },
    ],
  });
  if (r.threw !== undefined) throw new Error(`specify threw: ${r.threw.message}`);
  const oc = r.outcome as Outcome | undefined;
  if (oc === undefined) throw new Error("specify recorded no outcome");
  return { kind: oc.kind, outcome: JSON.parse(JSON.stringify(oc)) as unknown };
}

/** Drive both runs and capture both texts, with the switch left exactly as the environment found it. */
export async function captureOffArm(issue: number): Promise<PreservesOffRecord> {
  const spec = parsePiSpec(FIVE_BODY);
  if (!spec.ok) throw new Error(`fixture spec refused: ${spec.reason}`);
  // The prompt is the STEP's own text for the panel run — the same production call the arm under test
  // makes, not a second hand-built one whose arguments could drift from the step's.
  const arm = await capturePreservesPanelArm(issue, captureRows());
  return {
    prompt: arm.prompt,
    schema: submitTestsSchemaText(),
    gap: await driveSpecify(issue, FIVE_BODY, GREEN),
    freeze: await driveSpecify(issue + 1, FIVE_BODY, RED),
  };
}

/** The panel's rows as the capture drives them: four reds and one green whose row declares itself preserved. */
export function captureRows(): PanelRow[] {
  return PANEL_IDS.map((id) => ({
    id,
    script: id === "AC5" ? greenFile() : redFile(),
    ...(id === "AC5" ? { preserves: true } : {}),
  }));
}

/**
 * The one mask both sides apply: a fresh fixture repo cannot reproduce a sha or a temp path, so the capture
 * and the arm under test must fold them to the same text. It runs on the JSON TEXT of a record, where the
 * only quotes around a value are JSON's own — so a value's own quotes end the match and the whole path,
 * backslash included, is folded.
 */
export function maskPreservesText(text: string): string {
  return text
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replace(/[^"\s]*\.worktrees[\\/]lean-[0-9]+/g, "<worktree>")
    .replace(/issue #[0-9]+/g, "issue #<n>")
    .replace(/\b#\d+\b/g, "#<n>");
}

/** The mask, over a whole record — how the fixture file is written. */
export function maskPreserves(record: PreservesOffRecord): PreservesOffRecord {
  return JSON.parse(maskPreservesText(JSON.stringify(record))) as PreservesOffRecord;
}

/** The five-criterion body, exported so the on-arm test drives the same spec the capture drove. */
export const PANEL_BODY = FIVE_BODY;
export const PANEL_REL = REL;

/**
 * The OFF arm's two texts, produced by the production path under the switch's off setting.
 *
 * The caller sets PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES=0 and compares what comes back with the fixture's
 * `prompt` and `schema` fields — the pre-change tree's own bytes, captured once from the base commit by
 * the script beside the fixture. The step's own record is compared by the test through the shared panel
 * fixture, which drives the same production path the capture script drove.
 */
export async function capturePreservesOff(): Promise<{ prompt: string; schema: string }> {
  const arm = await capturePreservesPanelArm(issue, captureRows());
  return { prompt: arm.prompt, schema: submitTestsSchemaText() };
}

/** The committed fixture, parsed — the pre-change tree's own answer. */
export function readPreservesFixture(): PreservesOffRecord {
  const file = path.join(import.meta.dir, "..", PRESERVES_FIXTURE);
  return JSON.parse(readFileSync(file, "utf8")) as PreservesOffRecord;
}

/**
 * The OFF arm's record of the panel shape: the same five-criterion spec, the same four red files plus one
 * green file whose row declares `preserves: true`, driven through the real `specify` step.
 *
 * The pre-field tree never looks at the field, so what IT recorded for these rows is the off arm's answer —
 * the coverage gap, with no preserved list and no disclosure. The capture script drives this beside the two
 * single-file runs above so the off-arm comparison is the panel run itself, not a near relation of it.
 */
export async function capturePreservesPanel(
  issue: number,
  rows: PanelRow[],
): Promise<PreservesRunRecord> {
  const { repoRoot, baseSha } = panelRepo();
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue,
    config: configWith({ fast: "true", test: "sh {file}" }),
    specBody: FIVE_BODY,
    writes: (wt) => {
      for (const row of rows)
        if (row.script !== undefined) put(wt, row.rel ?? testRel(row.id), row.script);
    },
    toolUses: rows.map((row) => ({
      name: "submit_tests",
      arguments: {
        criterionId: row.id,
        testFiles: [row.rel ?? testRel(row.id)],
        ...(row.preserves === undefined ? {} : { preserves: row.preserves }),
      },
    })),
  });
  if (r.threw !== undefined) throw new Error(`specify threw: ${r.threw.message}`);
  const oc = r.outcome as Outcome | undefined;
  if (oc === undefined) throw new Error("specify recorded no outcome");
  return { kind: oc.kind, outcome: JSON.parse(JSON.stringify(oc)) as unknown };
}

/**
 * The panel run's record and kickoff prompt under the arm the caller set.
 *
 * Same rows, same spec, same production path as the capture; the test compares what comes back with the
 * fixture's `panel` and `prompt` fields. `preserves` is on the rows regardless of the arm — the whole claim
 * is that the pre-field tree read them as ordinary rows.
 */
export async function capturePreservesPanelArm(
  issue: number,
  rows: PanelRow[],
): Promise<{ record: PreservesRunRecord; prompt: string }> {
  const { repoRoot, baseSha } = panelRepo();
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue,
    config: configWith({ fast: "true", test: "sh {file}" }),
    specBody: PANEL_BODY_FIXTURE,
    prompts,
    writes: (wt) => {
      for (const row of rows)
        if (row.script !== undefined) put(wt, row.rel ?? testRel(row.id), row.script);
    },
    toolUses: rows.map((row) => ({
      name: "submit_tests",
      arguments: {
        criterionId: row.id,
        testFiles: [row.rel ?? testRel(row.id)],
        ...(row.preserves === undefined ? {} : { preserves: row.preserves }),
      },
    })),
  });
  if (r.threw !== undefined) throw new Error(`specify threw: ${r.threw.message}`);
  const oc = r.outcome as Outcome | undefined;
  if (oc === undefined) throw new Error("specify recorded no outcome");
  return {
    record: {
      kind: oc.kind,
      outcome: JSON.parse(maskPreservesText(JSON.stringify(oc))) as unknown,
    },
    prompt: prompts[0] ?? "",
  };
}
