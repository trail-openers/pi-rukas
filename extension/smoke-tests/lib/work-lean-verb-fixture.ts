/**
 * Fixtures for `test-headless-work-lean.ts` and its lock/trust companion,
 * split out so neither file carries the whole verb's surface (AGENTS.md §12).
 *
 * The three shapes here are the ones a test of the `work-lean` verb needs and
 * cannot get from the shared `headless-verb-harness.ts`:
 *
 *   - `fakeRun` / `step` — a `RunLeanResult` whose step log is whatever the case
 *     is about, with everything else the record has to carry filled in.
 *   - `verbRun` — the verb driven with an injected `run`, plus the mode the verb
 *     handed that run (the headless thread is observable only there).
 *   - `spawnProbe` — the verb run in a REAL child. The harness captures stdout
 *     and leaves stderr alone, so a `traceWarn` the verb writes is invisible to
 *     it; a child with nothing captured shows what the runner really puts on
 *     stderr, which is what a host diagnosing a crash reads.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSubcommand } from "../../src/headless/cli.ts";
import { runWorkLeanVerb } from "../../src/headless/work-lean.ts";
import type { LeanRunOutcome } from "../../src/headless/work-lean.ts";
import type { RunLeanResult } from "../../src/lean/engine.ts";
import type { LeanState, Step } from "../../src/lean/state.ts";
import type { DriverHost } from "../../src/work-driver-host.ts";
import { runVerb } from "../headless-verb-harness.ts";

export const REPO = "/tmp/pi-rukas-work-lean-verb";
export const SRC = path.resolve(import.meta.dirname, "..", "..", "src");

/** A run whose step log is `steps` and whose stamp is `code`/`state`. */
export function fakeRun(overrides: {
  code: number;
  state: LeanState;
  reason?: string;
  steps?: Step[];
}): RunLeanResult {
  return {
    code: overrides.code,
    state: overrides.state,
    run: {
      schema: 1,
      issue: 7,
      version: "0.0.0-test",
      models: {},
      baseSha: "feedbeef1234567890feedbeef1234567890abcd",
      branch: "feature/issue-7-thing",
      state: overrides.state,
      counters: {
        buildAttempts: 1,
        challengeDone: true,
        reviewDone: false,
        ciFixUsed: false,
        draft: false,
      },
      steps: overrides.steps ?? [],
      result: { code: overrides.code, reason: overrides.reason ?? "because" },
    },
  };
}

export function step(state: Step["state"], outcome: Step["outcome"] = { kind: "ok" }): Step {
  return { key: `7:${state}:0`, state, startedAt: 1, endedAt: 2, outcome };
}

/** What an injected `run` was asked to do, and what it was asked with. */
export interface InjectedRun {
  /** What the verb handed the engine as this run's mode. */
  mode?: { headless?: boolean };
  /** Whether the injected run was called at all (argv refusals must not call it). */
  ran: boolean;
}

export type VerbRun = Awaited<ReturnType<typeof runVerb>> & InjectedRun;

/**
 * Run the verb with an injected `run`, checking the shared output contract.
 *
 * `reply` is what the engine would have returned; it sees the opts the verb
 * passed, which is the only place the headless thread can be observed without
 * starting the real engine.
 */
export async function verbRun(
  argv: string[],
  reply: (opts: { headless?: boolean }) => Promise<LeanRunOutcome | undefined>,
): Promise<VerbRun> {
  const asked: { headless?: boolean }[] = [];
  let ran = false;
  const r = await runVerb("work-lean", argv, REPO, (_argv, ctx) =>
    runWorkLeanVerb(argv, ctx, async (_root, _issue, opts) => {
      ran = true;
      asked.push(opts ?? {});
      // `undefined` is a legal reply for a malformed-outcome case and the verb
      // judges it (`wellFormed`) rather than this fixture pre-deciding: an
      // `as never` here hid that the seam accepts anything the test invents.
      return (await reply(opts ?? {})) as LeanRunOutcome;
    }),
  );
  return { ...r, mode: asked[0], ran };
}

/** Run the verb with a `run` that throws `err`. */
export async function verbThrowing(argv: string[], err: unknown): Promise<VerbRun> {
  return verbRun(argv, async () => {
    throw err;
  });
}

/**
 * Run the verb in a real child whose injected `run` is `runSource`, and return
 * the child's stderr.
 *
 * `echoMessages` mirrors the host's `sendUserMessage` onto stderr so a case can
 * see what the verb TOLD the host, which the harness swallows.
 */
export async function spawnProbe(runSource: string, echoMessages = false): Promise<string> {
  return (await spawnProbeRun(runSource, echoMessages)).stderr;
}

/** `spawnProbe` plus the child's exit code and its whole stderr in one result. */
export async function spawnProbeRun(
  runSource: string,
  echoMessages = false,
): Promise<{ stderr: string; code: number | null }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "work-lean-probe-"));
  const probe = path.join(dir, "probe.ts");
  // `join` rather than a chain of `+` over template literals: the last segment
  // has no interpolation at all, which a concatenated literal cannot express
  // without tripping the linter's template rules.
  //
  // `process.exit` is reached through a tick (`setTimeout(…, 0)`) so a piped
  // stderr is flushed before the child dies — with an inherited fd the write is
  // synchronous and the delay is free.
  writeFileSync(
    probe,
    [
      `import { runWorkLeanVerb } from ${JSON.stringify(path.join(SRC, "headless", "work-lean.ts"))};`,
      `import { LeanLockError } from ${JSON.stringify(path.join(SRC, "lean", "lock.ts"))};`,
      `const host = { sendUserMessage: (t: string) => { if (${String(echoMessages)}) process.stderr.write(t + "\\n"); }, emit: () => {} };`,
      runSource,
      `const out = await runWorkLeanVerb(["7"], { repoRoot: ${JSON.stringify(dir)}, host }, run);`,
      "setTimeout(() => process.exit(out.exitCode), 0);",
    ].join("\n"),
  );
  // stdout AND stderr are piped. The existing callers read only stderr and an
  // inherited fd is what they always had; the AC driver reads both, because it
  // judges what the host's stdout carried as well as what the trace said.
  const r = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 30_000 });
  await rm(dir, { recursive: true, force: true });
  return { stderr: r.stderr, code: r.status };
}

/**
 * Run the verb with a host whose `sendUserMessage` throws, and return the
 * document the harness still got on stdout plus its exit code.
 *
 * The point of the shape is that the ONLY thing broken is the chat channel: the
 * run itself succeeds (or throws, per `crash`), and the verb must still hand the
 * host exactly one document and one code. A `sendUserMessage` that throws on the
 * OPENING send used to escape the verb entirely — it sat before the guarded
 * region — so a host with a closed stream got a stack trace instead of an answer.
 */
export async function verbThrowingHost(
  crash: boolean,
  send: (text: string, n: number) => void = () => {
    throw new Error("host channel closed");
  },
): Promise<{ code: number; docs: string[] }> {
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code = -1;
  let sends = 0;
  try {
    const host: DriverHost = {
      sendUserMessage: (text) => send(text, sends++),
      emit: () => {},
    };
    // Through `runSubcommand`, the way a host actually runs a verb: the verb
    // returns a `VerbOutcome` and the CLI is what prints the one document. A
    // guard that let the verb's own throw escape would show here as no document.
    code = await runSubcommand(
      "work-lean",
      ["7"],
      REPO,
      () => {},
      (argv, _ctx) =>
        runWorkLeanVerb(argv, { repoRoot: REPO, host }, async () => {
          if (crash) throw new Error("git exploded");
          return {
            summary: "work-lean #7: landed (exit 0)",
            result: fakeRun({ code: 0, state: "landed" }),
          };
        }),
    );
  } finally {
    process.stdout.write = write;
  }
  const docs = out
    .join("")
    .split("\n")
    .filter((l) => l.trim() !== "");
  // The document count is returned, not asserted here: the caller asserts it, and
  // a throwing `sendUserMessage` that let a second document through (or swallowed
  // the one) is the failure those assertions exist to catch.
  return { code, docs };
}

export interface CrashDrive {
  /** The exit code `runSubcommand` returned (a rejected run leaves it undefined). */
  code: number;
  /** The stdout document(s) the host received. */
  docs: string[];
  /** The shared output contract's verdict — every AC asserts this is empty. */
  violations: string[];
  /** The verb's NDJSON `log` lines from the child's stderr, when probed. */
  trace: string[];
  /** The child's exit code, when probed. */
  probeCode: number | null;
  /** `doc.error.code` from the in-process run. */
  errorCode?: string;
  /** `doc.error.message` from the in-process run. */
  message?: string;
}

/**
 * The shared driver for the #1909 AC tests: throw `err` from the injected run
 * and report what the host got.
 *
 * One driver, three AC files. Each used to carry its own copy of the stdout
 * capture and its own `safe`/`note` helpers, and a copy that checked less was a
 * copy that could pass while the contract broke. Two drives, because neither
 * sees the whole contract on its own:
 *
 *   - the in-process `verbThrowing` (which is `runVerb`, so the shared NDJSON
 *     `violations` check applies) gives the code, the one document, and the
 *     parsed `error`;
 *   - `spawnProbeRun` runs the SAME throw in a real child, because the harness
 *     captures stdout and leaves stderr alone — a `traceWarn` is visible only
 *     to a child that writes the real fd, which is what a host reads when a run
 *     dies. `probeCode` is that child's own exit code.
 *
 * The probe is given `runSource` rather than `err`: the child builds the value
 * itself, so a hostile getter is real code in the probe, not a value this file
 * has to serialise.
 */
export async function driveThrow(err: unknown, runSource: string): Promise<CrashDrive> {
  const r = await verbThrowing(["7"], err);
  const error = (r.doc.error ?? {}) as { code?: string; message?: string };
  const probe = await spawnProbeRun(runSource, true);
  return {
    code: r.code,
    docs: r.violations.some((v) => v.startsWith("stdout is not JSON"))
      ? []
      : [JSON.stringify(r.doc)],
    violations: r.violations,
    trace: probe.stderr.split("\n").filter((l) => l.trim() !== ""),
    probeCode: probe.code,
    errorCode: error.code,
    message: error.message,
  };
}

/**
 * One probe's stderr as the `[pi-rukas] WARN` lines it carries — the verb's
 * crash trace. The verb writes a plain-text warning through `traceWarn` and the
 * probe leaves stderr inherited (as the runner's own trace path does), so the
 * line is read as written rather than as an NDJSON envelope.
 */
export function warnLines(trace: string[]): string[] {
  return trace.filter((line) => line.startsWith("[pi-rukas] WARN"));
}

/** A child whose injected run throws one Error with a two-frame stack. */
export function spawnCrash(): Promise<string> {
  return spawnProbe(
    `const run = async () => { const e = new Error("git exploded"); e.stack = ["Error: git exploded", "    at runWorkLeanVerb (/x/work-lean.ts:1:1)"].join(String.fromCharCode(0x0a)); throw e; };`,
  );
}

/**
 * A child whose stack is far longer than `TRACE_MAX`, for the bound's own test.
 *
 * 200 KB of frames — fifty times the cap — so a verb that never cut would show
 * it rather than hide it, and the frames carry a marker the assertion looks for
 * so a trace truncated to nothing cannot pass a length check.
 */
export function spawnHugeCrash(): Promise<string> {
  return spawnProbe(
    `const run = async () => { const e = new Error("huge"); e.stack = ["Error: huge", ...Array.from({ length: 6000 }, () => "    at frameMark (/x/engine.ts:1:1)")].join(String.fromCharCode(0x0a)); throw e; };`,
    true,
  );
}

/**
 * The trace BODY of a crash line: what follows `crashed — <name>: `.
 *
 * `TRACE_MAX` bounds the body, not the whole record — the `work-lean: #N` framing
 * and the `name` label are added outside that cut (the label has its own bound,
 * `NAME_MAX`). Stripping the label by the name the probe threw is what makes the
 * body assertion bite: a whole-line length would tolerate a label that grew.
 * A line without that head is returned whole, so it fails the length check
 * rather than passing it.
 */
export function traceBody(line: string, name: string): string {
  const head = `crashed — ${name}: `;
  const at = line.indexOf(head);
  return at < 0 ? line : line.slice(at + head.length);
}
