/**
 * lib/verify-develop-criteria-harness — drive the classic develop gate's command-criteria
 * tier over a real repository, from one call.
 *
 * Split out of `test-work-driver-verify-command-criteria-classic.ts` for the 500-line cap,
 * along the seam that already existed inside that file: the driver is one translation from a
 * case's intent ("this arm has no discoverable verify command", "this arm moves HEAD
 * mid-run") into fixture + state + gate call, and it is mechanical. The assertions are the
 * interesting half and they stay in the suites, where a reader can see which arm answers
 * which question.
 *
 * Keeping the driver here rather than duplicating it is what lets the suites safely
 * disagree: the tier suite and the env-scrub suite drive the SAME arm shapes, so a case
 * cannot pass in one file by way of an option the other file never learned to set.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COMMAND_CRITERIA_PREFIX } from "../../src/work-driver-verify-develop-command-criteria.ts";
import { verifyDevelopOutcome } from "../../src/work-driver-verify-develop.ts";
import {
  GREEN_CRITERION,
  RUNNER_SCRIPT,
  RUNNER_TEMPLATE,
  specBody,
  workJsonWithRunnerTemplate,
} from "./verify-develop-criteria-fixture.ts";
import {
  type ProvenanceFixture,
  makeProvenanceFixture,
} from "./verify-develop-provenance-fixture.ts";

/** The prefix of a runner's env-report line. A line is matched by prefix, so the prefix is
 * named once here rather than written in both the emitter and the reader. */
const REPORT_PREFIX = "REPORTED:";

/** `echo "REPORTED:NAME=${NAME:-EMPTY}" >&2` for one name. Built with `String.fromCharCode`
 * because the line is shell text inside a template literal: a literal `$` would otherwise
 * start a nested substitution and `${NAME}` would be evaluated in TypeScript, not in sh. */
function envReportLine(name: string): string {
  const dollar = String.fromCharCode(36);
  return `echo "${REPORT_PREFIX}${name}=${dollar}{${name}:-EMPTY}" >&2`;
}

/** What a drive reported for the names it asked to see: the runner's own value, `EMPTY` for a
 * key present but blank, or `MISSING` when no line for that name reached the harness — which
 * is what a runner that never ran at all looks like. A scrub that DELETES a knob and one that
 * BLANKS it are different bugs, so the two spellings are never collapsed. */
export type ReportedEnv = Record<string, string>;

/** What one drive of the develop gate produced, plus the fixture so a case can clean up. */
export interface CriteriaRun {
  failures: string[];
  notes: string[];
  ok: boolean;
  f: ProvenanceFixture;
  /** The failures this tier owns — the ones carrying its own prefix. A case asserts on these
   * rather than on `failures`, so a defect from another develop gate can never be counted as
   * this tier's verdict (or hide one). */
  mine: string[];
  /** The env values the project's runner reported for this drive's `echoEnv` names. */
  reported: ReportedEnv;
}

export interface CriteriaRunOptions {
  criteria?: Record<string, unknown>[];
  /** Contents for the criterion's test file; a file containing FAIL makes the runner exit 1. */
  testFileContent?: string;
  workJson?: Record<string, unknown> | null;
  /** `""` makes the chain skip entirely; undefined lets the fixture default it to "". */
  verifyCmd?: string;
  body?: string | null;
  extraDevelopFiles?: Record<string, string>;
  /** Moves HEAD immediately before the project's verify command runs, so the tier reads one
   * OID before the runs and a different one after them. The drift the ordering check exists
   * for — and the arm that decides whether a red survives. */
  moveHeadDuringRun?: boolean;
  /** More than one entry marks the cycle grouped, which the tier refuses to judge: the cached
   * artifact holds the PRIMARY issue's body, so a sibling's criteria are not in the text it
   * reads. */
  issues?: number[];
  /** The workstream's effective base for EVERY workstream. An invalid sha is how the no-base
   * note arm is reached — `effectiveBaseFor` answers undefined and the tier declines the
   * worktree rather than guessing a ref to judge it against. */
  baseSha?: string;
  /** An invalid sha for ONE workstream: `workstreamBaseShas` is read per id and falls back to
   * the cycle base unless the entry is a valid sha, so this is the driver's own shape for a
   * workstream whose base could not be resolved. */
  baseShaFor?: Record<string, string>;
  /** Drive more than one workstream, one per id. Each worktree is the develop child's own (the
   * fixture creates one), so a two-workstream arm sees the criteria run twice — which is what
   * makes the note's counts a statement about one workstream and not the cycle. */
  workstreams?: string[];
  /** Set immediately before the gate is driven and restored after it returns, so a case can
   * put a value in the DRIVER's own `process.env` and observe what the project's runner
   * receives. The scrubbing under test is a property of the driver's environment, so a case
   * that set the knob inside the fixture would be testing the fixture. */
  env?: Record<string, string | undefined>;
  /** Names the env keys the case wants echoed back from inside the runner script. Each name
   * the runner saw is reported on `reported`; one it never saw reports `MISSING`. */
  echoEnv?: string[];
}

/** Write the composite body the explore step would have written, under the state dir. */
function writeBodyArtifact(
  f: ProvenanceFixture,
  criteria: Record<string, unknown>[] | undefined,
  body: string | null | undefined,
): string | undefined {
  if (body === null) return undefined;
  const text = body ?? specBody(criteria ?? [GREEN_CRITERION]);
  const rel = `.pi/work-state/2283/issue-body.txt`;
  mkdirSync(path.join(f.repo, ".pi", "work-state", "2283"), { recursive: true });
  writeFileSync(path.join(f.repo, rel), text);
  return rel;
}

/** The project's runner script, extended to echo the env names the case asked to see. The
 * base script is the shared one — a case that echoes nothing runs byte-identical bytes to
 * every other suite's, so the extension cannot be the reason an arm changed colour. */
function runnerScript(echoEnv: string[] | undefined): string {
  if (echoEnv === undefined || echoEnv.length === 0) return RUNNER_SCRIPT;
  const echoes = echoEnv.map(envReportLine).join("\n");
  const fail = 'if grep -q FAIL "$1"; then echo "FAILED: $1" >&2; exit 1; fi';
  return `#!/bin/sh\n${echoes}\n${fail}\nexit 0\n`;
}

/** The values the runner reported for the names in `echoEnv`, keyed by name. Read out of the
 * harness's notes rather than a file, so an assertion quotes the runner's own report. */
function reportedEnv(notes: readonly string[], echoEnv: string[] | undefined): ReportedEnv {
  const out: ReportedEnv = {};
  for (const line of notes) {
    if (!line.startsWith(REPORT_PREFIX)) continue;
    const m = /^REPORTED:([^=]+)=(.*)$/.exec(line);
    if (m) out[m[1] as string] = m[2] as string;
  }
  if (echoEnv) for (const name of echoEnv) out[name] ??= "MISSING";
  return out;
}

/**
 * Drive the develop gate once.
 *
 * `verifyCmd` deliberately controls ONLY the discovered verify command: when absent, the
 * chain prints "no verify command discoverable" and runs nothing, which is the state the
 * criteria must survive. The runner script and the criterion's test file are committed at the
 * base either way, because the tier's own rule is that a command criterion's file must be
 * byte-identical to base.
 */
export async function runCriteria(opts: CriteriaRunOptions): Promise<CriteriaRun> {
  const f = await makeProvenanceFixture({
    issue: 2283,
    baseFiles: {
      ...(opts.workJson === null
        ? {}
        : {
            ".pi/work.json": JSON.stringify(
              opts.workJson ?? workJsonWithRunnerTemplate(),
              null,
              2,
            ),
          }),
      "tests/run.sh": runnerScript(opts.echoEnv),
      "tests/quota.test.ts": opts.testFileContent ?? "ok\n",
      ...(opts.verifyCmd === undefined ? {} : { ".pi/verify-cmd": `${opts.verifyCmd}\n` }),
    },
    // One committed file always: the develop gate's own hollow-diff rule refuses a run whose
    // every worktree is empty, and that failure is not what these cases are about.
    developFiles: {
      "src/quota.ts": "export const quota = 1;\n",
      ...(opts.extraDevelopFiles ?? {}),
    },
    // "" is the caller's own command string, forwarded verbatim so the harness's argv-prefix
    // match never fires and the chain sees exactly what the fixture's .pi/verify-cmd holds.
    verifyCommand: opts.verifyCmd ?? "",
    // Lets the executor recognise the tier's argv-form runner call and fire the drift hook.
    runnerTemplate: opts.workJson === null ? undefined : RUNNER_TEMPLATE,
    ...(opts.workstreams === undefined ? {} : { extraWorkstreams: opts.workstreams }),
    ...(opts.moveHeadDuringRun === undefined
      ? {}
      : {
          beforeVerify: async () => {
            await f.commit("drift/late-commit.ts", "export const late = 1;\n");
          },
        }),
  });
  const artifact = writeBodyArtifact(f, opts.criteria, opts.body);
  const failures: string[] = [];
  const notes: string[] = [];
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await verifyDevelopOutcome(
      f.ctxFor(),
      f.stateFor(
        {
          ...(artifact === undefined ? {} : { issueBodyArtifact: artifact }),
          ...(opts.workstreams === undefined
            ? {}
            : {
                workstreams: Object.fromEntries(
                  opts.workstreams.map((id) => [
                    id,
                    { id, scope: `workstream ${id}`, paths: [], outOfScope: [] },
                  ]),
                ),
              }),
          ...(opts.baseShaFor === undefined ? {} : { workstreamBaseShas: opts.baseShaFor }),
        },
        {
          ...(opts.issues === undefined ? {} : { issues: opts.issues }),
          ...(opts.baseSha === undefined ? {} : { baseSha: opts.baseSha }),
        },
      ),
      f.execFn,
      failures,
      notes,
      {},
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  }
  return {
    failures,
    notes,
    ok: failures.length === 0,
    f,
    mine: failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX)),
    reported: reportedEnv(notes, opts.echoEnv),
  };
}

/** Remove a drive's scratch tree. Every case ends with this, so a suite leaves no repositories
 * behind even when its assertions failed. */
export function cleanupCriteriaRun(r: CriteriaRun): void {
  rmSync(r.f.root, { recursive: true, force: true });
}
