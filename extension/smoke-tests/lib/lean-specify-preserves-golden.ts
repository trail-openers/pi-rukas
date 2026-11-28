/**
 * lib/lean-specify-preserves-golden — the OFF-arm record of the specify preservation declaration.
 *
 * `test-lean-specify-preserves-off-arm.ts` compares what `PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES=0` produces
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

/** The committed path of the fixture, relative to `smoke-tests/`. */
export const PRESERVES_FIXTURE = "fixtures/lean-state/specify-preserves-off-2668.json";
/** The base commit the capture was taken from — the last one with no `preserves` field. */
export const PRESERVES_BASE_COMMIT = "231491a7f8";
/** The env name the switch reads. */
export const PRESERVES_KNOB = "PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES";

/** Five `verify: "test"` criteria, the shape both panel rows had. */
const FIVE_BODY = `\`\`\`pi-spec v1
${JSON.stringify(
  {
    problem: "The retry helper gives up on the first transient failure.",
    size: "S",
    criteria: [
      { id: "AC1", text: "retries a transient failure twice", verify: "test" },
      { id: "AC2", text: "gives up on a non-transient error", verify: "test" },
      { id: "AC3", text: "times out a hung request", verify: "test" },
      { id: "AC4", text: "keeps the existing retry budget readable", verify: "test" },
      { id: "AC5", text: "logs one line per attempt", verify: "test" },
    ],
  },
  null,
  2,
)}
\`\`\``;

const REL = "tests/AC4-guard.test.sh";
/** A file that passes on the base: the child's own `preserves: true` is its claim about it. */
const GREEN = "#!/bin/sh\necho \"ok - $(basename \"$0\")\"\nexit 0\n";
/** A file that fails on the base and names itself — the ordinary red test. */
const RED = [
  "#!/bin/sh",
  'echo "not ok - $(basename \"$0\")" 1>&2',
  "exit 1",
  "",
].join("\n");

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

/** Run the real specify step over a real repo with one declared file, whose content the caller chooses. */
async function driveSpecify(issue: number, body: string, script: string): Promise<PreservesRunRecord> {
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const config = configWith({ fast: "true", test: "sh {file}" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue,
    config,
    specBody: body,
    writes: (wt) => put(wt, REL, script),
    toolUses: [{ name: "submit_tests", arguments: { criterionId: "AC4", testFiles: [REL], preserves: true } }],
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
  const prompt = specifyPrompt({
    issue,
    spec: spec.spec,
    testRunner: "sh {file}",
    worktree: "/tmp/lean-preserves-worktree",
  });
  return {
    prompt,
    schema: submitTestsSchemaText(),
    gap: await driveSpecify(issue, FIVE_BODY, GREEN),
    freeze: await driveSpecify(issue + 1, FIVE_BODY, RED),
  };
}

/** Mask the shas and the worktree path a fresh fixture repo cannot reproduce. */
export function maskPreserves(record: PreservesOffRecord): PreservesOffRecord {
  const mask = (s: string): string =>
    s.replace(/\b[0-9a-f]{40}\b/g, "<sha>").replace(/\/tmp\/lean-specify-[A-Za-z0-9]+/g, "<tmp>");
  return JSON.parse(mask(JSON.stringify(record))) as PreservesOffRecord;
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
  const spec = parsePiSpec(FIVE_BODY);
  if (!spec.ok) throw new Error(`fixture spec refused: ${spec.reason}`);
  return {
    prompt: specifyPrompt({
      issue: 2668,
      spec: spec.spec,
      testRunner: "sh {file}",
      worktree: "/tmp/lean-preserves-worktree",
    }),
    schema: submitTestsSchemaText(),
  };
}

/** The committed fixture, parsed — the pre-change tree's own answer. */
export function readPreservesFixture(): PreservesOffRecord {
  const file = path.join(import.meta.dir, "..", PRESERVES_FIXTURE);
  return JSON.parse(readFileSync(file, "utf8")) as PreservesOffRecord;
}
