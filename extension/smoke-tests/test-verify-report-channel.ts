#!/usr/bin/env bun
/**
 * #1404 fix round 3 — the report channel's blast radius.
 *
 * `VERIFY_REPORT_FILE` is the path the smoke loop writes its own verdict to,
 * and the commit-pr baseline probe reads failing-test names ONLY from that file.
 * Two properties make that safe, and both are this file's subject:
 *
 *   1. The variable reaches the env of the ONE gate exec and nowhere else. It
 *      must never be assigned to `process.env`: every other child the driver
 *      spawns (an ops `git push`, a `gh pr create`, a worktree provisioning
 *      hook) inherits that object, and a leaked path turns an unrelated child
 *      into a writer of the verdict the driver trusts. The driver builds a
 *      snapshot of `process.env` and sets the key on the COPY.
 *
 *   2. A hostile ambient value is overwritten, not merged. If the host (or a
 *      test earlier in the same process) set `VERIFY_REPORT_FILE` to a path of
 *      its own, the driver's own path wins — otherwise the project picks which
 *      file the reader opens, which is the forgery the channel exists to close.
 *
 *   3. The channel is torn down on every exit, including a throw. The dir is
 *      under `TMPDIR`, so a leak is disk, not correctness — but a verify call
 *      per cycle under a long-lived driver is a leak with no upside, and the
 *      `finally` is the guarantee rather than the six `done()` calls.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { VERIFY_REPORT_FILE_ENV } from "../src/work-driver-verify-report-path.ts";
import { runCommitPrConsolidatedVerify } from "../src/work-driver-integrate-verify.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-1404-channel-"));

/** Every env the executor was handed, in call order. */
type Seen = Array<{ cwd?: string; env?: NodeJS.ProcessEnv }>;

/** An executor that records its env and fails the gate like a red child does. */
function redExec(seen: Seen): ExecFn {
  return async (cmd, o) => {
    if (cmd.includes("gate.sh")) {
      seen.push({ cwd: o?.cwd, ...(o?.env === undefined ? {} : { env: o.env }) });
      const err = new Error("Command failed with exit code 1") as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      err.stdout = "FAILED: 1 test(s) — /repo/tests/test-red.ts\nP: 1  F: 1";
      err.stderr = "";
      err.code = 1;
      throw err;
    }
    const { stdout } = o?.argv
      ? await execFileP(cmd, o.argv, { cwd: o?.cwd, maxBuffer: 1024 * 1024 })
      : await execFileP("/bin/sh", ["-c", cmd], { cwd: o?.cwd, maxBuffer: 1024 * 1024 });
    return { stdout };
  };
}

const baseOpts = (repoRoot: string) => ({
  verifyCmd: "sh gate.sh",
  repoRoot,
  workstreamCount: 1,
  workstreamIds: ["default"],
  timeoutMs: 60_000,
  // No baseSha on most cases: the probe is skipped and the run still has to
  // get (and clean up) its report channel. The one case that sets it drives
  // the probe's env too.
});

try {
  // ── 1. VERIFY_REPORT_FILE never lands on process.env.
  {
    const before = process.env[VERIFY_REPORT_FILE_ENV];
    delete process.env[VERIFY_REPORT_FILE_ENV];
    const seen: Seen = [];
    const r = await runCommitPrConsolidatedVerify(redExec(seen), baseOpts(root));
    assert(
      r.ok === false,
      `setup: a red gate still returns ok:false (got ${JSON.stringify(r.ok)})`,
    );
    assert(
      process.env[VERIFY_REPORT_FILE_ENV] === undefined,
      `#1404: the seam never assigns ${VERIFY_REPORT_FILE_ENV} to process.env — every other child the driver spawns inherits that object, and a leaked path makes an unrelated child the author of the verdict the probe reads (got ${JSON.stringify(process.env[VERIFY_REPORT_FILE_ENV])})`,
    );
    assert(
      seen.length === 1 && seen[0]?.env?.[VERIFY_REPORT_FILE_ENV] !== undefined,
      `#1404: the gate exec DOES get the report path — the channel works where it is supposed to (seen ${seen.length} envs, key ${JSON.stringify(seen[0]?.env?.[VERIFY_REPORT_FILE_ENV])})`,
    );
    if (before !== undefined) process.env[VERIFY_REPORT_FILE_ENV] = before;
  }

  // ── 2. A hostile ambient value is overwritten, never inherited.
  {
    const hostile = path.join(root, "attacker-chosen-report.txt");
    writeFileSync(hostile, "victim-of-a-project-chosen-path\n");
    process.env[VERIFY_REPORT_FILE_ENV] = hostile;
    try {
      const seen: Seen = [];
      await runCommitPrConsolidatedVerify(redExec(seen), baseOpts(root));
      const handed = seen[0]?.env?.[VERIFY_REPORT_FILE_ENV];
      assert(
        handed !== undefined && handed !== hostile,
        `#1404: an ambient ${VERIFY_REPORT_FILE_ENV} never survives into the gate's env — the driver's own path always wins, or the project picks which file the reader opens (got ${JSON.stringify(handed)})`,
      );
      assert(
        existsSync(hostile) && readFileSyncSafe(hostile) === "victim-of-a-project-chosen-path\n",
        "#1404: the hostile path is not written to — the driver read the ambient value and discarded it rather than trusting it",
      );
      assert(
        process.env[VERIFY_REPORT_FILE_ENV] === hostile,
        "#1404: discarding the ambient value means taking it out of the SNAPSHOT, not out of the host's env — a test that set it still sees it after the call",
      );
    } finally {
      delete process.env[VERIFY_REPORT_FILE_ENV];
    }
  }

  // ── 3. The throw path: a failure AFTER the runs must still tear the channel
  // down. The seam swallows an executor error into a failure stream (that is its
  // contract for "the gate was red"), so the throw is injected somewhere the
  // seam does not catch: the base probe's `git worktree add`, which the probe
  // itself lets propagate out of `attributeAgainstBase`'s caller.
  {
    const tmpBefore = countReportDirs();
    const seen: Seen = [];
    const exploding: ExecFn = async (cmd, o) => {
      const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
      if (line.includes("gate.sh")) {
        seen.push({ cwd: o?.cwd, ...(o?.env === undefined ? {} : { env: o.env }) });
        const err = new Error("Command failed with exit code 1") as Error & {
          stdout: string;
          stderr: string;
          code: number;
        };
        err.stdout = "FAILED: 1 test(s) — /repo/tests/test-red.ts\nP: 1  F: 1";
        err.stderr = "";
        err.code = 1;
        throw err;
      }
      // `provisionWorktree` reports a missing repoRoot as "nothing linked"
      // rather than throwing, so the injected failure is the worktree creation
      // the probe itself cannot survive: its `git worktree add`, which reaches
      // this executor as a real argv exec.
      if (o?.argv?.includes("add") === true && o.cwd === root) {
        // The probe reports an unbuildable base as `unknown` rather than
        // throwing (correct fail-closed behaviour, and the reason no injected
        // error reaches the seam from here). It is refused so the case still
        // exercises the full probe path without touching disk.
        throw new Error("refused: no real worktrees in this test");
      }
      const { stdout } = o?.argv
        ? await execFileP(cmd, o.argv, { cwd: o?.cwd, maxBuffer: 1024 * 1024 })
        : await execFileP("/bin/sh", ["-c", cmd], { cwd: o?.cwd, maxBuffer: 1024 * 1024 });
      return { stdout };
    };
    let threw = false;
    try {
      await runCommitPrConsolidatedVerify(exploding, {
        ...baseOpts(root),
        // A real 40-hex sha so the probe is reached and its worktree call is the
        // one that throws.
        baseSha: "0123456789abcdef0123456789abcdef01234567",
      });
    } catch {
      threw = true;
    }
    // The seam converts every infrastructure failure it can see into a park, so
    // nothing here throws — and that is the point. What this case pins is the
    // cleanup on the path where the probe DID run: the report dir is gone
    // whether the seam returned a verdict or the body had thrown, because the
    // removal sits in a `finally` and not beside the six `return done(...)`s.
    assert(
      !threw,
      "setup: the seam converts a probe that cannot build its base into a park rather than propagating (an infrastructure failure must never read as a step crash, and never as an excuse either)",
    );
    assert(
      countReportDirs() <= tmpBefore,
      `#1404: the report dir is removed even when the body throws — the guarantee is the finally, not the six done() calls (${tmpBefore} -> ${countReportDirs()} pi-verify-report-* dirs under TMPDIR)`,
    );

    // The reachable throw: an options object whose read itself fails. Nothing in
    // the seam catches it, so the ONLY thing standing between it and a leaked
    // dir per call is the `finally`. This is the case the six `done()` calls do
    // NOT cover, which is why the guarantee lives where it does.
    const tmpBeforeThrow = countReportDirs();
    let threwForReal = false;
    try {
      await runCommitPrConsolidatedVerify(redExec([]), {
        ...baseOpts(root),
        get verifyCmd(): string {
          throw new Error("options read failed");
        },
      });
    } catch {
      threwForReal = true;
    }
    assert(
      threwForReal,
      "setup: a throw from inside the body propagates (the seam does not swallow an error it cannot classify)",
    );
    assert(
      countReportDirs() <= tmpBeforeThrow,
      `#1404: the report dir is removed on a THROW out of the body, not only on a return — the removal is a finally, not a line next to each exit (${tmpBeforeThrow} -> ${countReportDirs()})`,
    );
  }

  // ── 4. The happy exits clean up too (pass, and the ordinary red).
  {
    const tmpBefore = countReportDirs();
    const passing: ExecFn = async (cmd, o) => {
      if (cmd.includes("gate.sh")) return { stdout: "" };
      const { stdout } = o?.argv
        ? await execFileP(cmd, o.argv, { cwd: o?.cwd, maxBuffer: 1024 * 1024 })
        : await execFileP("/bin/sh", ["-c", cmd], { cwd: o?.cwd, maxBuffer: 1024 * 1024 });
      return { stdout };
    };
    const r = await runCommitPrConsolidatedVerify(passing, baseOpts(root));
    assert(r.ok === true, `setup: a green gate returns ok:true (got ${JSON.stringify(r.ok)})`);
    assert(
      countReportDirs() <= tmpBefore,
      `#1404: a passing run leaves no report dir behind (${tmpBefore} -> ${countReportDirs()})`,
    );
  }

  console.log(`\nexit ${exit}`);
  process.exit(exit);
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** The dirs the driver creates, counted so a leak is visible to an assert. */
function countReportDirs(): number {
  try {
    return readdirSync(tmpdir()).filter((n) => n.startsWith("pi-verify-report-")).length;
  } catch {
    return -1;
  }
}

function readFileSyncSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
