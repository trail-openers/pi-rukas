/**
 * #1863 — a real reviewer child killed at its run bound must produce a
 * dispatch result the driver can route, and the runner must still print one
 * result document.
 *
 * WHY A REAL PROCESS. The unit-level tests in this suite inject
 * `ctx.adversarialLoopFn`, so they can prove what the driver DOES with a
 * bound-killed child but not that a bound-killed child ARRIVES: the whole field
 * failure was in the boundary between spawn and driver. Three of the four
 * defects this issue fixed are invisible to an injected loop:
 *
 *   1. `classifyDispatchOutcome` had no `child-bound` branch, so the loop
 *      re-spawned the same review into the same bound (M1).
 *   2. The exit await in `spawn.ts` had no bound, so a child that never
 *      reported exit left the dispatch unresolved forever (M3).
 *   3. The runner printed nothing at all when its driver never settled (M3).
 *
 * So this file spawns a REAL `spawnSpecialist` against the suite's fake `pi`
 * (the `trap` variant, which ignores SIGTERM, so only the escalation ends it),
 * with a real per-child bound, and asserts on what the spawn actually returns.
 * Then it drives the real headless CLI as a real child process and asserts that
 * stdout carries exactly one parseable document and that the process never
 * exits 0 with an empty stream — the field symptom, verbatim:
 *
 *   pi-rukas-headless: #1863 not-started (exit 30)
 *   error: crash — the runner process exited 0 without a result
 *
 * OFFLINE IN SUBSTANCE, LIVE IN NAME. No model is contacted: the `pi` on PATH is
 * the suite's shell-script fake. The file still carries the `-live` suffix
 * because it calls `spawnSpecialist` directly, and the offline loop sets
 * `PI_ENSEMBLE_FORBID_LIVE_SPAWN=1`, whose guard (`assertLiveSpawnAllowed`)
 * refuses any non-injected spawn of an agent role regardless of what is on
 * PATH. The suffix is the suite's declared exception for exactly that shape —
 * `test-cancel-realspawn-live.ts` is the precedent — and `*-live.ts` is how
 * every caller excludes real-spawn tests. Running it:
 *
 *   PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1 bun smoke-tests/\
 *     test-work-driver-adversarial-bound-realspawn-live.ts
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDispatchOutcome } from "../src/adversarial-classify.ts";
import { spawnSpecialist } from "../src/spawn.ts";
import { classifyFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import { writeFakePi } from "./lib/cancel-fixture.ts";

// The offline loop forbids non-injected spawns; this file's whole first section
// IS one, against the suite's fake `pi`. Declared live for the guard, offline in
// every other respect — no `pi`, no model, no tokens.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "headless", "cli.ts");

const fakeDir = mkdtempSync(join(tmpdir(), "pi-1863-real-"));
const repoDir = mkdtempSync(join(tmpdir(), "pi-1863-repo-"));
const savedPath = process.env.PATH;
const savedBound = process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS;
const savedGrace = process.env.PI_ENSEMBLE_CHILD_BOUND_GRACE_MS;

/** Run the real CLI as a real child process and collect its streams. */
async function runCli(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("exit", (code) => resolve({ stdout, stderr, code }));
    setTimeout(() => {
      try {
        process.kill(-child.pid as number, "SIGKILL");
      } catch {
        /* gone */
      }
      child.kill("SIGKILL");
    }, 120_000).unref();
  });
}

const docs = (s: string) => s.trim().split("\n").filter((l) => l.trim().length > 0);

try {
  // ── 1. A REAL child killed at its run bound: the spawn RESOLVES, with the
  // cause the driver routes on.
  process.env.PATH = `${fakeDir}:${savedPath}`;
  // 200 ms bound with a 50 ms grace: the child is steered at the bound and
  // ended 50 ms later, so the whole kill happens in a quarter-second. The grace
  // knob is set beside the bound because the schedule kills at bound + grace —
  // leaving the 10-minute default in place would have this probe wait for a
  // grace window the test is not testing.
  process.env.PI_ENSEMBLE_CHILD_BOUND_GRACE_MS = "50";
  const pidFile = join(fakeDir, "bound.pid");
  const grandPidFile = join(fakeDir, "bound.grand.pid");
  // `trap` — the fake IGNORES SIGTERM, so the escalation is what ends it. This
  // is the shape that made the field failure a hang rather than a kill.
  writeFakePi(fakeDir, "trap", pidFile, grandPidFile, 60_000);
  const t0 = Date.now();
  const r = await spawnSpecialist(
    { role: "adversarial-developer", prompt: "review this diff" },
    { childBoundMs: 200, timeoutMs: 60_000, processGroup: true },
  );
  const wall = Date.now() - t0;
  assert(
    wall < 30_000,
    `a real child bound-killed at 200ms RESOLVES the dispatch (${wall}ms) — the exit await cannot be the thing that never settles`,
  );
  assert(
    r.killCause === "child-bound",
    `the kill is attributed to the per-child run bound (killCause=${r.killCause ?? "none"}, ok=${r.ok})`,
  );
  assert(r.ok === false, "a killed child is not reported as a success");

  // The classifier the loop consults must agree: a bound kill is a self-kill
  // and is NOT retried. Without this branch it fell to `crashed` →
  // shouldRetry:true, and the loop re-spawned the same review into the same
  // bound — the measured double-kill in the field transcript.
  const cls = classifyDispatchOutcome(r);
  assert(
    cls.cause === "self-killed:child-bound" && cls.shouldRetry === false && cls.maxRetries === 0,
    `the loop's classifier says self-killed / no-retry for a real bound kill (cause=${cls.cause}, shouldRetry=${cls.shouldRetry}, maxRetries=${cls.maxRetries}) — re-spawning would spend the bound again`,
  );
  // And the driver's taxonomy must agree with it: two classifiers, one kill.
  const tax = classifyFailureCause({ killCause: "child-bound" } as never);
  assert(
    tax.cause === "self-killed:child-bound" && tax.shouldRetry === false,
    `the driver's taxonomy says the same thing about the same kill (cause=${tax.cause}, shouldRetry=${tax.shouldRetry}) — the two classifiers must not disagree`,
  );

  // ── 2. The headless runner always emits exactly one result document.
  {
    const out = await runCli(["work", "1863", "--json"], { PI_ENSEMBLE_HEADLESS: "1" }, repoDir);
    const lines = docs(out.stdout);
    assert(
      lines.length === 1,
      `a real runner prints exactly one result document, whatever it concluded (exit ${out.code}, ${lines.length} line(s))`,
    );
    if (lines.length === 1) {
      let doc: { exitCode?: number; issues?: unknown[] } | undefined;
      try {
        doc = JSON.parse(lines[0] as string);
      } catch {
        doc = undefined;
      }
      assert(
        doc !== undefined && Array.isArray(doc.issues) && typeof doc.exitCode === "number",
        "the document is parseable JSON with the per-issue array and a numeric exitCode",
      );
      assert(
        doc?.exitCode === out.code,
        `the process exits with the code its own document declares (doc ${doc?.exitCode} vs process ${out.code})`,
      );
    }
  }

  // ── 3. A driver that never answers is REPORTED, not silently dropped. The
  // wedge bound is driven to 1 ms so the guarantee fires before the driver can
  // answer, and the scratch directory is NOT a git repository: a repo-shaped
  // cwd resolves, runs to a legitimate handoff, and must not be reported as
  // wedged — that confusion is what the first draft of this case mistook.
  {
    const scratch = mkdtempSync(join(tmpdir(), "pi-1863-wedge-"));
    // A real clone, so the driver gets PAST its start gates and is genuinely at
    // work when the wedge bound fires. The earlier draft used a bare
    // directory: the driver refused at `resolveRepoRoot`, exited inside
    // `runHeadless`, and the supervisor honestly reported `crash` for a runner
    // that had died — a passing assertion about the wrong thing. Nothing here
    // reaches the network: `gh` cannot resolve a repository in a clone with no
    // remote, so the cycle parks on `explore-bodies-empty` in seconds.
    const git = (a: string[]) =>
      spawnSync("git", a, { cwd: scratch, stdio: "ignore", timeout: 20_000 });
    git(["init", "-q", "-b", "main", "."]);
    git(["remote", "add", "origin", "https://github.invalid/pi-rukas/neither"]);
    writeFileSync(join(scratch, "README.md"), "# wedge fixture\n");
    git(["add", "README.md"]);
    git(["-c", "user.email=t@invalid", "-c", "user.name=t", "commit", "-q", "-m", "base"]);
    const out = await runCli(
      ["work", "1863", "--json"],
      { PI_ENSEMBLE_HEADLESS: "1", PI_ENSEMBLE_HEADLESS_DRIVER_WEDGE_MS: "1" },
      scratch,
    );
    const lines = docs(out.stdout);
    assert(
      lines.length === 1,
      `with the wedge bound tripped the runner still prints exactly one document (exit ${out.code}, ${lines.length} line(s))`,
    );
    if (lines.length === 1) {
      const doc = JSON.parse(lines[0] as string) as {
        exitCode?: number;
        error?: { code?: string };
        issues?: Array<{ issue: number }>;
      };
      // #1863 — the supervisory wedge is the OUTER process's view of a run whose
      // inner guarantee answered. The runner (the supervisor's child) honours the
      // wedge, prints `driver-wedged` with its own exitCode 30 and exits 30; the
      // supervisor now forwards those bytes and that code unchanged instead of
      // overwriting them with its own `crash` projection (which is what the host
      // reads, since only the supervisor's stdout reaches the host). Verified here
      // end to end; `test-headless-runner-result-document.ts` asserts the inner
      // half and `test-headless-supervise.ts` both directions of the passthrough.
      assert(
        doc.error?.code === "driver-wedged",
        `the supervisory wedge reports the runner's own driver-wedged document (error=${JSON.stringify(doc.error)})`,
      );
      assert(
        doc.exitCode === 30 && out.code === 30,
        `a wedged run exits 30 in both the document and the process (doc ${doc.exitCode}, process ${out.code})`,
      );
      assert(
        Array.isArray(doc.issues) && doc.issues.some((i) => i.issue === 1863),
        `and still projects the issue it was asked about (issues=${JSON.stringify(doc.issues?.map((i) => i.issue))})`,
      );
    }
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log("OK: #1863 a real bound-killed reviewer resolves, and the runner always reports");
} finally {
  process.env.PATH = savedPath;
  delete process.env.PI_ENSEMBLE_CHILD_BOUND_GRACE_MS;
  if (savedGrace === undefined) delete process.env.PI_ENSEMBLE_CHILD_BOUND_GRACE_MS;
  else process.env.PI_ENSEMBLE_CHILD_BOUND_GRACE_MS = savedGrace;
  if (savedBound === undefined) delete process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS;
  else process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS = savedBound;
  rmSync(fakeDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
}

process.exit(exit);
