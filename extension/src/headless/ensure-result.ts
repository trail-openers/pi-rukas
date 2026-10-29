/**
 * headless/ensure-result — the runner cannot exit without a result document
 * (#1863, AC5).
 *
 * `cli.ts` wrote its stdout result in two places only: the `--json` branch
 * inside `main()`, and the `.catch` for a rejected `main()`. If `main()` never
 * settled — the field shape, where the adversarial round-review child was
 * killed at its run bound and the driver's await on the child's `exit` event
 * stayed pending — the loop drained and the runner exited 0 with an empty
 * stdout. The supervisor then printed `error: crash — the runner process exited
 * 0 without a result` and its own exit 30, and the host had nothing to act on
 * for a cycle that had written a state file.
 *
 * The fix has two halves. The real one is in `spawn-exit-await.ts`: the exit
 * await is bounded, so the dispatch resolves. This module is the guarantee that
 * the CONTRACT holds regardless — the runner's stdout carries exactly one
 * result document on every path on which it terminates, including a wedged
 * driver whose promise never settles. It is a backstop, not a substitute: a run
 * that reports through it is a run whose driver never answered, and the
 * document says so (`error.code: "driver-wedged"`) and exits 30, which is the
 * honest code for that. The supervisor's crash/30 classification is untouched.
 */

import { resourceReport } from "../resource-budget.ts";
import { isTerminalState, readState, workStateFile } from "../workflow-state.ts";
import { readBuildCommit, readBuildVersion } from "./build.ts";
import { EXIT, exitCodeForState } from "./exit-code.ts";
import { type IssueResult, notStartedResult, projectIssue, resultDocument } from "./result.ts";

/**
 * How long the runner waits for its own driver before calling it wedged.
 *
 * There is deliberately **no env knob** for this. It is a reporting backstop, not
 * a timeout policy: lowering it makes the runner print `driver-wedged` for a
 * cycle that is merely slow, so an operator who "tightens" it gets a lie rather
 * than a faster cycle. Tests that need the bound to fire reach it through
 * `ResultGuaranteeOpts.wedgeMs`, which is the injection seam `write` already is
 * for the stream. A knob nobody is meant to turn cannot drift, cannot be set to
 * a value that misreports a healthy run, and never has to appear in
 * `HEADLESS_INPUTS` — where every entry is a promise a host may set.
 */
export const DEFAULT_WEDGE_MS = 6 * 60 * 60_000;

export interface RunOutcome {
  exitCode: number;
  results: IssueResult[];
  error?: { code: string; message: string };
}

/** Each issue as its state file shows it; a non-terminal state exits 30. */
export async function projectFromStateFiles(
  repoRoot: string,
  issues: number[],
): Promise<IssueResult[]> {
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

/**
 * The projection of a run whose driver never answered: every issue read back
 * from its own state file, exit 30, and an error that names the driver as the
 * thing that stopped — never a bare "exited 0 without a result".
 */
export async function wedgedRun(
  repoRoot: string,
  issues: number[],
  reason: string,
): Promise<RunOutcome> {
  const results = await projectFromStateFiles(repoRoot, issues);
  return {
    exitCode: EXIT.crash,
    results,
    error: {
      code: "driver-wedged",
      message: `the run produced no result (${reason}); each issue is projected from its state file`,
    },
  };
}

/** One result document, in the shape `cli.ts` writes for `work`. */
export function formatResultDocument(run: RunOutcome, json: boolean): string {
  if (json) {
    // The ONE builder (`result.ts`'s `resultDocument`), so the wedge document
    // and the supervisor's crash document can never drift in schema version,
    // build fields or key order (#1863 round 1). `resources` stays the CLI's
    // additive field, added at the write site as everywhere else.
    const doc = resultDocument(run, {
      commit: readBuildCommit(),
      version: readBuildVersion(),
    });
    return `${JSON.stringify({ ...doc, resources: resourceReport() })}\n`;
  }
  const parts = run.results.map((r) => `#${r.issue} ${r.status} (exit ${r.exitCode})`);
  const head = `pi-rukas-headless: ${parts.join(", ") || "nothing ran"}\n`;
  // #1866 — the machine line. The summary and the error line are what a person
  // reads; they are not what the SUPERVISOR reads. `supervise.ts` decides "did
  // my child answer" with `parseResultLine`, which accepts only a line that
  // parses as a result document carrying this build's `schemaVersion`, an
  // `issues` array and a published `exitCode`. A text-mode child printed neither,
  // so a runner that ran the cycle and returned honestly was answered for a
  // `crash`/30 projected over its own results — the sibling of Fix A, and the
  // reason text mode reported `crash` long before e8852593. The line is emitted
  // LAST so the human-facing summary stays the first thing on the stream; the
  // supervisor forwards only the whitelisted prose lines (`proseLinesBefore`) and
  // then the document (text mode is
  // promised the summary — #1866 follow-up), and the one-document latch still
  // admits exactly one call per process. The document
  // is built by the same `resultDocument` the `--json` branch uses, so the two
  // modes cannot drift in schema version or key order (#1863 round 1) — and it
  // carries the same `resources` report, so the DOCUMENT BYTES a text-mode host
  // reads are byte-identical to the ones a `--json` host reads. A machine line
  // that differed between the modes by a field would make `resources` a mode
  // artefact rather than a property of the run.
  const doc = resultDocument(run, {
    commit: readBuildCommit(),
    version: readBuildVersion(),
  });
  const machine = `${JSON.stringify({ ...doc, resources: resourceReport() })}\n`;
  const errorLine = run.error ? `error: ${run.error.code} — ${run.error.message}\n` : "";
  return `${head}${errorLine}${machine}`;
}

export interface ResultGuaranteeOpts {
  /** The run itself. If it never settles, the guarantee prints the wedge. */
  work: () => Promise<RunOutcome>;
  json: boolean;
  /**
   * Where the wedge projection reads the state files from. A callback so the
   * CLI can hand in the repo root it is still resolving: by the time the wedge
   * fires the resolution has settled (or is itself the failure the document
   * reports), and the earlier `""` made every issue project from a path that
   * named no repository (#1863 round 1).
   */
  repoRoot: string | (() => string | Promise<string>);
  issues: number[];
  /** stdout sink; injectable so the offline test observes the stream. */
  write: (s: string) => void;
  /**
   * Override the wedge bound. `undefined` is the documented 6 h; `0` disables
   * the backstop. Tests inject a short bound here rather than through an env
   * var or a production CLI flag: the production default is not a knob (see
   * `DEFAULT_WEDGE_MS`).
   */
  wedgeMs?: number;
}

/**
 * Run `work` and leave EXACTLY ONE result document on stdout, whichever way it
 * settles.
 *
 * The single-writer property is structural: `work` returns a value and this is
 * the only thing that writes to `write`, so a document cannot be printed twice
 * and cannot be skipped. The byte-level check below is a second line of defence
 * for the case where `work` wrote through some other route — an earlier draft
 * keyed the decision on a `prints` flag describing the caller's INTENT, and
 * appended a wedge document to a healthy run's own output.
 */
export async function withResultGuarantee(opts: ResultGuaranteeOpts): Promise<number> {
  const wedgeMs = opts.wedgeMs ?? DEFAULT_WEDGE_MS;
  const work = opts.work();
  // Byte-level, not "did it call write": the supervisor's stdout is a passthrough
  // of the runner's, so the only honest test of "produced no result" is that
  // nothing arrived at all.
  let wrote = "";
  const write = (s: string) => {
    wrote += s;
    opts.write(s);
  };
  const settle = async (value: RunOutcome): Promise<number> => {
    const run = value;
    if (wrote.trim() === "") write(formatResultDocument(run, opts.json));
    return run.exitCode;
  };
  if (wedgeMs <= 0) return settle(await work);
  const wedged = new Promise<"wedged">((resolve) => {
    const t = setTimeout(() => resolve("wedged"), wedgeMs);
    t.unref?.();
  });
  const winner = await Promise.race([work, wedged]);
  if (winner !== "wedged") return settle(winner);
  const reason = `no driver result within ${wedgeMs}ms — the run was still awaiting a child when the runner stopped waiting`;
  // A caller that already put a document on the stream does not get a second
  // one; the wedge exists for the silent case only. Read the BYTES, not a flag:
  // an earlier draft keyed this on `prints` and appended a wedge document to a
  // healthy run's own output, because the flag described intent while the
  // stream described what the host actually sees.
  if (wrote.trim() !== "") {
    work.catch(() => undefined);
    // Something already reached the host, so a second document would break the
    // contract this module exists to keep. 30 says only what this call knows:
    // nothing settled in time.
    return EXIT.crash;
  }
  const repoRoot = await (typeof opts.repoRoot === "function" ? opts.repoRoot() : opts.repoRoot);
  const run = await wedgedRun(repoRoot, opts.issues, reason);
  write(formatResultDocument(run, opts.json));
  // A driver that settles later is abandoned: nothing it returns can be printed
  // now, and its locks / groups are released by cli.ts's exit path.
  work.catch(() => undefined);
  return run.exitCode;
}
