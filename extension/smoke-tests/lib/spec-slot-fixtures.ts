/**
 * Shared fixtures for the #1557 / #1725 spec-slot admission tests. Not a test
 * itself (no `test-` prefix, so the gate glob does not run it): the repo
 * builder, the real-`NormalisedSpec` factory, the fix-fence driver and the
 * one stderr/env capture helper the tests share.
 *
 * The stderr patch and the `PI_ENSEMBLE_DEBUG` write go through
 * {@link captureTraces} rather than each case hand-rolling a pair of
 * assignments: an assertion that threw between the patch and its restore left
 * `process.stderr.write` stubbed for every later case in the file, which reads
 * as a passing suite with its output swallowed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PostPass } from "../../src/work-driver-adversarial-fix-scope.ts";
import {
  defaultExec,
  type FixExec,
} from "../../src/work-driver-adversarial-fix-git.ts";
import { planFixPass, postPassFault } from "../../src/work-driver-adversarial-fix-scope.ts";
import type { NormalisedSpec } from "../../src/work-driver-intent.ts";
import type { PipelineState } from "../../src/workflow-state-schema.ts";
import type { WorkState } from "../../src/workflow-state.ts";
import { devCommit, fixState, git, repoWithFile } from "./adversarial-fix-fixtures.ts";

/** The slot the 500-line ratchet forced and `plannedPathProblem` forbids declaring. */
export const SLOT = "extension/src/review-ledger-*.ts";
export const NEW_FILE = "extension/src/review-ledger-pass.ts";
/** The concrete files the same deliverable declared. */
export const LEDGER_FILES = ["extension/src/review-ledger.ts", "extension/src/adversarial-ledger.ts"];
/** The rest of the workstream's declared scope. */
export const DECLARED = [...LEDGER_FILES, "extension/src/adversarial.ts", "a.txt"];

/** A real `NormalisedSpec` whose single deliverable declares exactly `paths`. */
export function specWith(paths: string[], id = "d"): NormalisedSpec {
  return {
    intent: "the fixture's intent",
    deliverables: [{ id, description: "the deliverable", paths }],
    acceptanceCriteria: ["the named files exist"],
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    evidence: [],
    verdict: "proceed",
    rationale: "fixture",
  };
}

/** A real `NormalisedSpec` whose d1 declares the concrete files plus `slots`. */
export function spec(slots: string[], id = "d1"): NormalisedSpec {
  return specWith([...LEDGER_FILES, ...slots], id);
}

/** A real repo: the declared files tracked at base, under an isolated git env. */
export function repo(label: string, extra: Record<string, string> = {}): string {
  const dir = repoWithFile(label);
  for (const f of [...DECLARED, ...Object.keys(extra)]) {
    mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    writeFileSync(path.join(dir, f), extra[f] ?? "export {};\n");
  }
  git(dir, "add -A");
  git(dir, 'commit -q -m "the declared scope"');
  return dir;
}

/** The one-workstream state the fence reads, with the cycle's spec attached. */
export function stateWith(
  dir: string,
  opts: {
    paths?: string[];
    outOfScope?: string[];
    specSource?: NormalisedSpec;
    findings?: string;
  },
): WorkState {
  const st = fixState(dir, opts.paths ?? DECLARED, opts.findings ?? `${LEDGER_FILES[0]}: split it`);
  return {
    ...st,
    pipelineState: {
      ...st.pipelineState,
      worktrees: { default: dir },
      workstreams: {
        default: {
          id: "default",
          scope: "row identity",
          paths: opts.paths ?? DECLARED,
          outOfScope: opts.outOfScope ?? [],
        },
      },
      ...(opts.specSource ? { normalisedSpec: opts.specSource } : {}),
    },
  };
}

/**
 * The fence alone: pre-pass plan, the developer's new files, the post-pass
 * verdict. `execFn` is injectable so a caller can watch the git reads; the
 * default runs them for real.
 */
export async function fenceVerdict(
  dir: string,
  st: WorkState,
  created: string[],
  execFn: FixExec = defaultExec,
): Promise<{ parked: string; post: PostPass; traces: string[] }> {
  const ps = st.pipelineState as PipelineState;
  const planned = await planFixPass(execFn, dir, ps, [
    { workstreamId: "default", findings: "the finding" },
  ]);
  if (!planned.ok) return { parked: planned.reason, post: { diffs: {}, admissions: [] }, traces: [] };
  for (const f of created) {
    mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    devCommit(dir, f, "export const split = 1;\n");
  }
  const { value: post, traces } = await captureTraces(() =>
    postPassFault(execFn, planned.value, ps.baseSha ?? ""),
  );
  return { parked: post.reason ?? "", post, traces };
}

/** Put an env var back the way it was — absent stays absent. */
function restoreEnv(key: string, was: string | undefined): void {
  if (was === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = was;
}

/**
 * Run `run` with `trace()`'s stderr captured and `PI_ENSEMBLE_DEBUG` on, and
 * RESTORE BOTH IN `finally` — including when `run` throws or asserts. Returns
 * the value and every chunk the trace writer saw.
 */
export async function captureTraces<T>(
  run: () => Promise<T>,
  debugOn = true,
): Promise<{ value: T; traces: string[] }> {
  const real = process.stderr.write.bind(process.stderr);
  const debug = process.env.PI_ENSEMBLE_DEBUG;
  const traces: string[] = [];
  if (debugOn) process.env.PI_ENSEMBLE_DEBUG = "1";
  else Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DEBUG");
  process.stderr.write = ((chunk: string | Uint8Array) => {
    traces.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await run(), traces };
  } finally {
    process.stderr.write = real;
    restoreEnv("PI_ENSEMBLE_DEBUG", debug);
  }
}

/** The synchronous form of {@link captureTraces} for a non-async body. */
export function captureTracesSync<T>(run: () => T, debugOn = true): { value: T; traces: string[] } {
  const real = process.stderr.write.bind(process.stderr);
  const debug = process.env.PI_ENSEMBLE_DEBUG;
  const traces: string[] = [];
  if (debugOn) process.env.PI_ENSEMBLE_DEBUG = "1";
  else Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DEBUG");
  process.stderr.write = ((chunk: string | Uint8Array) => {
    traces.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: run(), traces };
  } finally {
    process.stderr.write = real;
    restoreEnv("PI_ENSEMBLE_DEBUG", debug);
  }
}

/**
 * Run `body` with the two fan-out tunables pinned to the tightest values
 * (factor 1, floor 1), so a single declared path bounds one file and the
 * numerator/denominator change is observable in one assertion. Restored in
 * `finally`.
 */
export function withTightFanout<T>(body: () => T): T {
  const factor = process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR;
  const min = process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN;
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = "1";
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = "1";
  try {
    return body();
  } finally {
    restoreEnv("PI_ENSEMBLE_SCOPE_FANOUT_FACTOR", factor);
    restoreEnv("PI_ENSEMBLE_SCOPE_FANOUT_MIN", min);
  }
}
