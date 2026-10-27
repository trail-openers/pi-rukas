/**
 * headless/supervise — a `work` run's result survives a runner that dies
 * (#1591).
 *
 * The runner writes its stdout result once, at the end. A runner that dies
 * natively — Bun aborts when it cannot create a thread, which a container at
 * its `pids.max` produces — writes nothing, so the host got an empty `--json`
 * result for a cycle that had already opened its PR. No JavaScript handler
 * runs on such an abort, so the only place that can still answer is another
 * process.
 *
 * `cli.ts` therefore runs `work` as a child of itself (marked by
 * SUPERVISED_ENV) and holds its stdout. When the child exits with a result,
 * that result is passed through unchanged with the child's exit code. When it
 * exits without one, the supervisor projects each issue from its state file —
 * which the driver persists at every step boundary and before every dispatch —
 * and reports `error.code: "crash"` with exit 30. stderr (the NDJSON progress
 * stream) is inherited and never touched.
 *
 * #1863 — "with a result" is decided by the BYTES, not by the exit code. The
 * inner runner has its own backstop (`ensure-result.ts`) that prints a
 * `driver-wedged` document — whose own `exitCode` is 30 — and exits 30 when its
 * driver never answered. The first shape of this file only asked whether stdout
 * was non-empty, which the wedge document satisfies; but the passthrough returned
 * the CHILD's exit code, and a runner that had printed its document and then
 * been torn down before the code reached the parent got the supervisor's own
 * `crash`/30 written on top of it. So the passthrough is now keyed on the stdout
 * carrying a COMPLETE, PARSEABLE result document (`parseResultDocument`) and
 * returns THAT document's `exitCode` — the child's exit code is the fallback,
 * not the authority. The `crash` projection remains exactly what a child that
 * printed nothing, or printed only garbage, gets — crash classification is
 * otherwise unchanged.
 *
 * A child that DIED is a different thing from a child that answered, so the
 * bytes only count when the child exited normally — no `exit.signal` and no
 * `exit.error`. A child that printed a healthy-looking document and then caught
 * SIGKILL is a crash whatever it printed: a killed process cannot vouch for the
 * document it wrote, and a host reading exit 0 / `merged` out of a killed runner
 * is the exact lie #1591 was filed to remove. A signal-killed or spawn-errored
 * child therefore keeps the `crash`/30 projection and its signal message, which
 * is what `headless.md` and `troubleshooting.md` promise. The wedge path still
 * passes through, because `withResultGuarantee` prints its document and then
 * RETURNS an exit code — that child exits normally.
 *
 * Only the document LINE is forwarded, never the whole buffer, so stdout carries
 * exactly one JSON document even when the child printed stray bytes first.
 *
 * SIGTERM / SIGINT / SIGHUP are forwarded to the child, so the interrupt
 * contract (run.ts) is unchanged. Setting `PI_ENSEMBLE_HEADLESS_SUPERVISED=1`
 * runs `work` in-process, without a supervisor.
 */

import { spawn } from "node:child_process";
import { resourceReport } from "../resource-budget.ts";
import { isTerminalState, readState, workStateFile } from "../workflow-state.ts";
import { readBuildCommit, readBuildVersion } from "./build.ts";
import { EXIT, exitCodeForState } from "./exit-code.ts";
import {
  type IssueResult,
  RESULT_SCHEMA_VERSION,
  type ResultDocument,
  notStartedResult,
  projectIssue,
  resultDocument,
} from "./result.ts";

export const SUPERVISED_ENV = "PI_ENSEMBLE_HEADLESS_SUPERVISED";

const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export interface SuperviseOptions {
  repoRoot: string;
  issues: number[];
  json: boolean;
  /** The child's argv: `[command, ...args]`. Defaults to re-running this CLI. */
  command: string[];
  write?: (s: string) => void;
}

/**
 * The last complete result document on a child's stdout, or undefined.
 *
 * "Complete" is load-bearing: a runner killed mid-write leaves a truncated line
 * that is neither nothing nor a document, and calling that a result would pass
 * a half-written one to the host. So only a line that parses as a result
 * document — the schema version this build writes, an `issues` array and an
 * `exitCode` that is one of the PUBLISHED codes — counts, and the LAST such
 * line wins (a runner that printed a document and then a stray line still gets
 * its document). The code is validated, not trusted: it is what the supervisor
 * returns to the host, so `Infinity`, a float, a negative or a number the
 * contract never published is not a result but garbage, and garbage is what the
 * `crash` projection is for.
 */
export function parseResultDocument(out: string): ResultDocument | undefined {
  const lines = out.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || !line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const doc = parsed as Partial<ResultDocument>;
    if (
      doc.schemaVersion === RESULT_SCHEMA_VERSION &&
      Array.isArray(doc.issues) &&
      isPublishedExitCode(doc.exitCode)
    ) {
      return parsed as ResultDocument;
    }
  }
  return undefined;
}

/**
 * Is `code` one of the exit codes the CLI publishes? The document's `exitCode`
 * becomes the supervisor's own return value, so an out-of-contract number must
 * not reach the host: only a non-negative safe integer from `EXIT` qualifies.
 */
function isPublishedExitCode(code: unknown): code is number {
  if (typeof code !== "number" || !Number.isSafeInteger(code)) return false;
  return Object.values(EXIT).includes(code as (typeof EXIT)[keyof typeof EXIT]);
}

/** Each issue as its state file shows it; a non-terminal state exits 30. */
async function projectFromState(repoRoot: string, issues: number[]): Promise<IssueResult[]> {
  const out: IssueResult[] = [];
  for (const issue of issues) {
    const file = workStateFile(repoRoot, issue);
    const state = await readState(repoRoot, issue).catch(() => undefined);
    if (!state) {
      out.push(notStartedResult(issue, file, EXIT.crash));
      continue;
    }
    const code = isTerminalState(state) ? exitCodeForState(state) : EXIT.crash;
    out.push({ ...projectIssue(state, file), exitCode: code });
  }
  return out;
}

/** Run `work` in a child and return the exit code to use. */
export async function superviseWork(opts: SuperviseOptions): Promise<number> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const [cmd, ...args] = opts.command as [string, ...string[]];
  const child = spawn(cmd, args, {
    env: { ...process.env, [SUPERVISED_ENV]: "1" },
    stdio: ["inherit", "pipe", "inherit"],
  });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const handlers = FORWARDED.map((sig) => [sig, forward(sig)] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  const exit = await new Promise<{ code: number | null; signal: string | null; error?: Error }>(
    (resolve) => {
      child.on("error", (error) => resolve({ code: null, signal: null, error }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );
  for (const [sig, h] of handlers) process.off(sig, h);
  const out = Buffer.concat(chunks).toString("utf8");
  // A child that never wrote a byte is indistinguishable from one whose bytes
  // were lost: `close` fires when the stdio STREAMS end, not when the process
  // is reaped, so a child that was still running when its pipes closed is
  // already past the point where anything it prints could be recovered. The
  // decision therefore reads the bytes (parseResultDocument) and nothing else —
  // and #1863's wedge document reaches this function exactly like the runner's
  // own result does, because ensure-result.ts writes it to the same stdout.
  // A child that died by a signal, or never started, has no say: its bytes are
  // not a result. Everything else with a complete document on stdout is.
  const answered = exit.signal || exit.error ? undefined : parseResultDocument(out);
  if (answered !== undefined) {
    // The document LINE, not the buffer: stray bytes ahead of it are not part
    // of the host's contract.
    write(`${JSON.stringify(answered)}\n`);
    return answered.exitCode;
  }
  const how = exit.error
    ? `could not start: ${exit.error.message}`
    : exit.signal
      ? `died with ${exit.signal}`
      : `exited ${exit.code} without a result`;
  const message = `the runner process ${how}; each issue is projected from its state file`;
  const results = await projectFromState(opts.repoRoot, opts.issues);
  if (opts.json) {
    const doc = resultDocument(
      { exitCode: EXIT.crash, results, error: { code: "crash", message } },
      { commit: readBuildCommit(), version: readBuildVersion() },
    );
    write(`${JSON.stringify({ ...doc, resources: resourceReport() })}\n`);
  } else {
    const parts = results.map((r) => `#${r.issue} ${r.status} (exit ${r.exitCode})`);
    write(`pi-rukas-headless: ${parts.join(", ")}\nerror: crash — ${message}\n`);
  }
  return EXIT.crash;
}
