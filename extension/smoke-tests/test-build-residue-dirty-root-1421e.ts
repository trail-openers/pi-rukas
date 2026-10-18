#!/usr/bin/env bun
/**
 * #1421 round 3 — the two reads this gate had left UNBOUNDED, and the reason
 * the probe's trace used to report the wrong failure.
 *
 * (1) `readRepoRootPreflight` and `readRepoRootDirt` both open with a bare
 *     `git status --porcelain -uall` carrying `cwd` and `maxBuffer` and NO
 *     `timeout`. Both run inside the integration lock, so a git that hangs on
 *     a lock another process holds did not stall one cycle — it held the lock
 *     and every consolidation queued behind it, reporting nothing. The bound is
 *     IGNORE_PROBE_TIMEOUT_MS, the same number the two probes already carry.
 *     These cases pin the option, and pin what a kill produces: the read
 *     rejects, and each caller's existing branch turns that into a bounded
 *     failure rather than a hang.
 *
 * (2) `probeIgnored` recorded `lastFailure` last-writer-wins, so the reason the
 *     trace printed was whichever batch happened to settle LAST. With four
 *     workers, an E2BIG whose siblings then timed out printed "killed" and the
 *     operator tuned a timeout instead of the batch size. It now records the
 *     FIRST failure and counts them, so the trace says how much of the probe
 *     could not run.
 *
 * Deliberately separate from `test-build-residue-dirty-root-1421d.ts` (356
 * lines): appending these would crowd that file toward the 500-line gate.
 */
import { readRepoRootDirt } from "../src/work-driver-branch-residue.ts";
import { readRepoRootPreflight } from "../src/work-driver-consolidated-verify-preflight.ts";
import { IGNORE_PROBE_TIMEOUT_MS, probeIgnored } from "../src/work-driver-ignore-probe.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface Call {
  cmd: string;
  timeout?: number;
}

function untracked(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`?? target/f${i}.o`);
  return out.join("\n");
}

/** Every read the gate issues, recorded with the options it was given. */
function recorder(behaviour: (c: Call) => Promise<{ stdout: string }>) {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, o) => {
    const call: Call = { cmd: o?.argv ? "git check-ignore" : cmd, timeout: o?.timeout };
    calls.push(call);
    return behaviour(call);
  };
  return { exec, calls };
}

const STATUS_OK = untracked(3);

const STATUS_CLEAN = "?? .worktrees/issue-1421-a/x.rs\n?? .pi/work-state/1421.json\n";

// ── A. both initial status reads carry the bound ───────────────────────────
// A hang inside the integration lock is the incident these cases guard: the
// number matters less than the presence of the option, so this asserts the
// bound exists and is the module's own constant rather than a literal that can
// drift from it. The root is clean (driver scaffolding only) so the "still
// works" half of each case says something.
{
  const { exec, calls } = recorder(async (c) => ({
    stdout: c.cmd.startsWith("git status --ignored") ? "" : STATUS_CLEAN,
  }));
  const out = await readRepoRootDirt(exec, "/repo");
  const status = calls.find((c) => c.cmd === "git status --porcelain -uall");
  assert(
    status?.timeout === IGNORE_PROBE_TIMEOUT_MS,
    `A: readRepoRootDirt bounds its status read (timeout: ${status?.timeout}, expected ${IGNORE_PROBE_TIMEOUT_MS})`,
  );
  assert(out === undefined, "A: the bounded read still classifies a clean root as clean");
}

{
  const { exec, calls } = recorder(async (c) => ({
    stdout: c.cmd.startsWith("git status --ignored") ? "" : STATUS_CLEAN,
  }));
  const out = await readRepoRootPreflight(exec, "/repo", undefined);
  const status = calls.find((c) => c.cmd === "git status --porcelain -uall");
  assert(
    status?.timeout === IGNORE_PROBE_TIMEOUT_MS,
    `A: readRepoRootPreflight bounds its status read (timeout: ${status?.timeout}, expected ${IGNORE_PROBE_TIMEOUT_MS})`,
  );
  assert(
    out === undefined,
    "A: the bounded preflight still returns no refusal for a clean root",
  );
}

// ── B. a status read that NEVER resolves, killed at its bound ──────────────
// The fake is the shape Node's exec timeout takes: no answer on its own, so
// the only thing that can end the promise is the caller honouring `timeout`
// (a real child killed at the bound rejects `killed` with no exit code). If the
// gate ignored the option, these awaits would sit until the smoke-test runner
// was reaped — which is exactly the production symptom, and the reason the
// bound lives here rather than in a comment.
function hangingStatusExec(
  overrideMs: number | undefined,
  onKill: () => void,
): { exec: ExecFn; kills: number } {
  let kills = 0;
  const exec: ExecFn = (cmd, o) => {
    if (o?.argv) return Promise.resolve({ stdout: "" }); // the probe answers
    if (!cmd.startsWith("git status --porcelain")) return Promise.resolve({ stdout: "" });
    // Two ways for the caller to have NO bound, both of which the pre-fix code
    // exhibited: the option absent, and the option present but meaningless to
    // this fake because it is the production 30 s the suite may not wait out.
    // `readRepoRootDirt`/`readRepoRootPreflight` hardcode
    // IGNORE_PROBE_TIMEOUT_MS, so an injected value is what lets the GREEN run
    // observe a kill in milliseconds; with the fix removed the fake hangs and
    // the whole file is reaped at the runner's bound — the production symptom.
    const declared = o?.timeout;
    const ms = overrideMs ?? (declared !== undefined && declared <= 5_000 ? declared : undefined);
    if (typeof ms !== "number" || ms <= 0) {
      return new Promise<{ stdout: string }>(() => {});
    }
    // Node's exec bound: the child is killed at `timeout` and the promise
    // rejects `killed` with no exit code. Reproduced here because the fake has
    // no child to kill — honouring `timeout` is the caller's job.
    return new Promise<{ stdout: string }>((_resolve, reject) => {
      setTimeout(() => {
        kills++;
        onKill();
        reject(Object.assign(new Error("killed"), { killed: true }));
      }, ms);
    });
  };
  return { exec, kills };
}

{
  // 20 ms: the 30 s production bound is what the assertion above pins, and a
  // smoke test must not wait out either of them. Passing `undefined` here
  // removes the injected bound entirely and the case hangs, which is the RED
  // shape this module documents.
  const started = Date.now();
  let kills = 0;
  const { exec } = hangingStatusExec(20, () => {
    kills++;
  });
  let settled = false;
  let dirt: string[] | undefined;
  let threw: unknown;
  try {
    dirt = await readRepoRootDirt(exec, "/repo");
    settled = true;
  } catch (err) {
    threw = err;
    settled = true;
  }
  const elapsed = Date.now() - started;
  assert(
    settled && threw instanceof Error && kills === 1,
    `B: the branch gate settles on a hung status read instead of hanging (settled: ${settled}, killed: ${kills}, threw: ${(threw as Error)?.message}, dirt: ${JSON.stringify(dirt)}, ${elapsed}ms)`,
  );
  assert(
    elapsed < 10_000,
    `B: the rejection is BOUNDED — it arrives at the injected timeout, not never (${elapsed}ms)`,
  );
}

{
  const started = Date.now();
  let kills = 0;
  const { exec } = hangingStatusExec(20, () => {
    kills++;
  });
  let settled = false;
  let out: unknown;
  let threw: unknown;
  try {
    out = await readRepoRootPreflight(exec, "/repo", undefined);
    settled = true;
  } catch (err) {
    threw = err;
    settled = true;
  }
  const elapsed = Date.now() - started;
  // The preflight does NOT swallow the rejection: `consolidatedVerify` treats a
  // throwing preflight as "cannot tell" and skips the batch, which is the
  // fail-closed direction (a root the gate cannot read is never consolidated
  // into). What must not happen is the lock being held indefinitely.
  assert(
    settled && kills === 1,
    `B: the preflight settles on a hung status read instead of holding the integration lock (settled: ${settled}, killed: ${kills}, threw: ${(threw as Error)?.message}, out: ${JSON.stringify(out)}, ${elapsed}ms)`,
  );
  assert(
    elapsed < 10_000,
    `B: the preflight's failure is BOUNDED, not a hang (${elapsed}ms)`,
  );
}

// ── C. the probe reports the FIRST failure and counts them ─────────────────
// Three batches. The first to REJECT is an E2BIG; the two that settle later are
// kills. Last-writer-wins printed the kill, so the trace pointed at a timeout
// and the batch size — the actual cause — never appeared.
{
  const stderr: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const exec: ExecFn = async (_cmd, o) => {
    const argv = o?.argv ?? [];
    const first = argv[3] ?? "";
    if (first === "target/f0.o") {
      // Rejects immediately — first to FAIL, though not first to settle last.
      throw Object.assign(new Error("argument list too long (E2BIG)"), { code: null });
    }
    if (first === "target/f500.o") {
      await new Promise((r) => setTimeout(r, 30));
      throw Object.assign(new Error("Killed"), { killed: true });
    }
    await new Promise((r) => setTimeout(r, 60));
    throw Object.assign(new Error("Killed late"), { killed: true });
  };
  let res: Set<string> | undefined;
  let threw = false;
  try {
    res = await probeIgnored(exec, "/repo", untracked(1500).split("\n"));
  } catch {
    threw = true;
  }
  process.stderr.write = realWrite;
  const log = stderr.join("");
  const counted = /(\d+) of (\d+) batch/.exec(log);
  assert(
    !threw && res === undefined,
    `C: every batch failing still voids the answer, and the gate does not throw (got ${res === undefined ? "undefined" : `a set of ${res.size}`})`,
  );
  assert(
    /E2BIG/.test(log),
    `C: the trace names the FIRST failure, not whichever batch settled last (log: ${log.slice(0, 220)})`,
  );
  assert(
    !/could not ask git \(killed\)/.test(log),
    "C: a later kill no longer overwrites the first failure's reason",
  );
  assert(
    counted !== null && counted[1] === "3" && counted[2] === "3",
    `C: the trace counts the failures out of the batches asked (got ${counted ? `${counted[1]} of ${counted[2]}` : "no count"})`,
  );
}

// ── D. one bad batch among good ones still voids, and says so ──────────────
{
  const stderr: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const exec: ExecFn = async (_cmd, o) => {
    const argv = o?.argv ?? [];
    if ((argv[3] ?? "") === "target/f1000.o") {
      throw Object.assign(new Error("spawn EACCES"), { code: null });
    }
    return { stdout: argv.filter((a) => a.startsWith("target/")).join("\n") };
  };
  const res = await probeIgnored(exec, "/repo", untracked(2500).split("\n"));
  process.stderr.write = realWrite;
  const log = stderr.join("");
  const counted = /(\d+) of (\d+) batch/.exec(log);
  assert(res === undefined, "D: a single failing batch still voids the whole answer");
  assert(
    counted !== null && counted[1] === "1" && counted[2] === "5",
    `D: the trace distinguishes one bad batch from a git that will not answer (got ${counted ? `${counted[1]} of ${counted[2]}` : "no count"})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
