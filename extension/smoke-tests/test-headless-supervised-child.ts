#!/usr/bin/env bun
/**
 * #1866 — the SUPERVISED runner child runs `main()`, and both tiers answer.
 *
 * `cli.ts` used to gate its entry block on
 * `process.env[SUPERVISED_ENV] !== "1"`. The supervisor re-spawns that same file
 * with `SUPERVISED_ENV=1` as the process that OWNS the run, so the child never
 * called `main()`: it exited 0 with an empty stdout, and the supervisor could
 * only project `crash — the runner process exited 0 without a result` for every
 * run from v0.14.30 through v0.14.40.
 *
 * The second defect lives one tier down and is visible in text mode (no
 * `--json`). `formatResultDocument(run, false)` printed a human summary and no
 * document at all, and `superviseWork` decides "did my child answer" with
 * `parseResultDocument`, which accepts ONLY a line that parses as a result
 * document carrying this build's `schemaVersion`, an `issues` array and a
 * published `exitCode`. A text-mode child therefore never answered either, and
 * a cycle that ran and returned honestly got the supervisor's `crash`/30 written
 * over its own results.
 *
 * Every existing offline test missed both because each one either (a) injects its
 * own `command:` into `superviseWork` — an inline `bun -e` script, never `cli.ts`,
 * so the entry guard is never executed — or (b) calls `main()` / a fixture entry
 * in-process, or (c) asserts only that A document exists, which the supervisor's
 * own crash projection satisfies. This test spawns the REAL `cli.ts`, which is
 * the only shape that exercises the entry guard and the real text-mode stream.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../src/headless/exit-code.ts";
import { RESULT_SCHEMA_VERSION } from "../src/headless/result.ts";
import { SUPERVISED_ENV } from "../src/headless/supervise.ts";

let exit = 0;
function assert(cond: boolean, msg: string, extra?: unknown) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`, extra === undefined ? "" : JSON.stringify(extra));
    exit = 1;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "headless", "cli.ts");

/** Run the real CLI as a real process, with a real pipe on stdout. */
function run(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
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
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    // A run that never exits is the other half of the bug: it answered nothing.
    const killer = setTimeout(() => {
      try {
        process.kill(-child.pid as number, "SIGKILL");
      } catch {
        /* gone */
      }
      child.kill("SIGKILL");
    }, 90_000);
    killer.unref?.();
  });
}

/** The result-document lines on a stream — the ones the host's contract is. */
const docs = (out: string): string[] =>
  out.split("\n").filter((l) => l.trim().startsWith("{") && l.includes('"schemaVersion"'));

type Doc = {
  schemaVersion?: number;
  exitCode?: number;
  issues?: unknown[];
  error?: { code?: string; message?: string };
};

const repo = await mkdtemp(join(tmpdir(), "headless-sup-child-"));
try {
  // ── 1. THE REGRESSION ITSELF: the supervised child reaches main().
  // Spawned exactly the way `superviseWork` spawns it — same env, same argv
  // shape (`bun cli.ts work N --json`), stdout a pipe. Before Fix A it printed
  // nothing and exited 0.
  {
    const out = await run(["work", "1900", "--json"], repo, { [SUPERVISED_ENV]: "1" });
    const lines = docs(out.stdout);
    assert(
      lines.length === 1,
      `the SUPERVISED child reaches main() and prints its own document (got ${lines.length} doc, exit ${out.code})`,
      { stdout: out.stdout.slice(0, 160), stderr: out.stderr.slice(0, 160) },
    );
    if (lines.length === 1) {
      const doc = JSON.parse(lines[0] as string) as Doc;
      assert(
        doc.schemaVersion === RESULT_SCHEMA_VERSION &&
          Array.isArray(doc.issues) &&
          typeof doc.exitCode === "number",
        "the child's document is a parseable result document",
        doc,
      );
      assert(
        doc.exitCode === out.code,
        `the child exits with the code it declared (doc ${doc.exitCode}, process ${out.code})`,
      );
      assert(
        doc.error?.code !== "crash",
        `the supervised child answers with its own result, not a crash projection (error=${JSON.stringify(doc.error)})`,
      );
      assert(
        Array.isArray(doc.issues) && doc.issues.length === 1,
        `the child reports the issue it was asked about (got ${JSON.stringify(doc.issues)})`,
      );
    } else {
      // The exact field symptom, stated as a failure rather than skipped over.
      assert(
        out.code !== 0,
        `an empty stdout with exit 0 is the #1866 symptom, never a pass (exit ${out.code})`,
      );
    }
  }

  // ── 2. END-TO-END through the real two-tier supervisor, --json.
  // The outer process spawns the inner one; exactly one document reaches the
  // host, and it is the RUN's, not the supervisor's crash projection.
  {
    const out = await run(["work", "1901", "--json"], repo);
    const lines = docs(out.stdout);
    assert(
      lines.length === 1,
      `the two-tier host reads exactly one document (got ${lines.length})`,
      {
        stdout: out.stdout.slice(0, 160),
      },
    );
    if (lines.length === 1) {
      const doc = JSON.parse(lines[0] as string) as Doc;
      assert(
        doc.error?.code !== "crash",
        `the run is not reported as a silent runner crash (error=${JSON.stringify(doc.error)}) — a crash here means the child exited without ever reaching main()`,
        { code: out.code },
      );
      assert(
        doc.exitCode === out.code,
        `the process exits with the code the document declares (doc ${doc.exitCode}, process ${out.code})`,
      );
      assert(
        doc.exitCode !== EXIT.crash || doc.error?.code === "driver-wedged",
        `exit 30 is only reported with a reason that names what stopped (error=${JSON.stringify(doc.error)})`,
      );
    }
  }

  // ── 3. THE PROPERTY THE OLD GUARD CLAIMED TO PROTECT: one document per
  // process, so admitting the supervised child cannot re-introduce a double.
  {
    const out = await run(["work", "1902", "--json"], repo, { [SUPERVISED_ENV]: "1" });
    assert(docs(out.stdout).length === 1, "one document per process — the latch still holds", {
      stdout: out.stdout.slice(0, 200),
    });
  }

  // ── 4. TEXT MODE (no --json): the supervisor must accept the child's output,
  // and must give the text-mode host the human lines with it.
  // Before Fix B the child printed a summary line and no document, so
  // `parseResultDocument` saw nothing and the supervisor wrote `crash`/30 over
  // results the runner had already produced. The fix that followed forwarded the
  // document LINE only, which made every text-mode host read a JSON blob and
  // lose the `pi-rukas-headless: #N status (exit N)` summary the docs promise:
  // the supervisor now forwards the child's non-document lines first, then the
  // one document line.
  {
    const out = await run(["work", "1903"], repo);
    const lines = docs(out.stdout);
    assert(
      lines.length === 1,
      `a text-mode run still carries exactly one result document for its supervisor (got ${lines.length})`,
      { stdout: out.stdout.slice(0, 200) },
    );
    const summary = out.stdout.split("\n").findIndex((l) => l.startsWith("pi-rukas-headless: #"));
    assert(
      summary !== -1,
      "the text-mode host still reads the human summary line, not only a JSON blob",
      { stdout: out.stdout.slice(0, 200) },
    );
    assert(
      summary !== -1 && summary < out.stdout.split("\n").findIndex((l) => docs(l).length === 1),
      "the summary line comes BEFORE the document line",
      { stdout: out.stdout.slice(0, 200) },
    );
    if (lines.length === 1) {
      const doc = JSON.parse(lines[0] as string) as Doc;
      assert(
        doc.error?.code !== "crash",
        `a text-mode run is NOT reported as a crash (error=${JSON.stringify(doc.error)}) — the supervisor read "no result" in a stream that answered`,
        { code: out.code },
      );
      assert(
        doc.exitCode === out.code,
        `the text-mode process exits with the code its document declares (doc ${doc.exitCode}, process ${out.code})`,
      );
      // The prose is NOT dropped any more — the assertion above is the host-facing
      // half of it. What the supervisor must still not forward is anything the
      // child printed AFTER its document, which is what the stray-bytes rule in
      // `test-headless-supervise.ts` covers at the unit tier.
      assert(
        doc.exitCode === EXIT.crash || doc.error === undefined,
        `a text-mode run reports either its own outcome or a named reason (error=${JSON.stringify(doc.error)}, exit ${doc.exitCode})`,
      );
    }
  }

  // ── 5. TEXT MODE, supervised child tier: the child answers on its own pipe.
  {
    const out = await run(["work", "1904"], repo, { [SUPERVISED_ENV]: "1" });
    assert(
      docs(out.stdout).length === 1,
      "the supervised child's text-mode stream carries its one document",
      { stdout: out.stdout.slice(0, 200) },
    );
    assert(
      out.code !== 0 || docs(out.stdout).length === 1,
      `no silent exit 0 from a text-mode supervised child (exit ${out.code})`,
    );
  }
} finally {
  await rm(repo, { recursive: true, force: true });
}

console.log("OK: #1866 the supervised runner child runs main, in both modes");
process.exit(exit);
