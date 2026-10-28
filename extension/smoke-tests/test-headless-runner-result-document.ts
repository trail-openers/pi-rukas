/**
 * #1863 M3 — the runner cannot exit 0 without a result document.
 *
 * The field evidence (verified by the PM against the real transcript):
 *
 *   pi-rukas-headless: #1863 not-started (exit 30)
 *   error: crash — the runner process exited 0 without a result
 *   FAILED (exit=30)
 *
 * `main()` in `headless/cli.ts` wrote its document in exactly two places: the
 * `--json` branch after `await runHeadless(...)`, and the `.catch` for a
 * rejected `main()`. A `main()` that NEVER SETTLED — the driver parked on the
 * child's `exit` event, whose only ref'd backing (the child's own libuv process
 * handle) had been released, with every timer around it `unref()`d — drained the
 * loop and the process exited 0 with an EMPTY stdout. `resultDocument` was dead
 * code on that path, and `formatResultDocument`/`withResultGuarantee` are the
 * replacement.
 *
 * Two properties are pinned, and they are different properties:
 *
 *   1. STRUCTURE — exactly one document, and a wedge that is reported rather
 *      than a silent exit. A real process cannot be made to leave `main()`
 *      unsettled on command, so this drives the guarantee with a never-settling
 *      `work()` — the same shape the driver had — and asserts on the projection
 *      it produces from a state file placed under a scratch repo root.
 *   2. END-TO-END — a real `bun cli.ts work` process always leaves stdout
 *      non-empty and never reports success on a run that produced nothing.
 *      That is the shape the host actually sees, and only a real process
 *      settles the argument "the process exited before the printing code ran".
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../src/headless/exit-code.ts";
import {
  formatResultDocument,
  wedgedRun,
  withResultGuarantee,
} from "../src/headless/ensure-result.ts";
import { initialState } from "../src/workflow-state.ts";

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
// Drives `main()` in-process and then attempts a second stdout write; the
// stdout-ownership case spawns this instead of the CLI (see its header).
const latchFixture = join(here, "lib", "headless-stdout-latch-fixture.ts");
const tmpRoot = await mkdtemp(join(tmpdir(), "pi-1863-runner-"));


/** Run the real CLI and collect stdout/stderr/exit without a shell. */
async function runCli(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  entry: string = cliPath,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
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
    // A run that outlives this bound is the other half of the bug: it did not
    // exit at all. Kill the whole group so no orphan is left behind.
    setTimeout(() => {
      try {
        process.kill(-child.pid as number, "SIGKILL");
      } catch {
        /* gone */
      }
      child.kill("SIGKILL");
    }, 90_000).unref();
  });
}

const docs = (s: string) => s.trim().split("\n").filter((l) => l.trim().length > 0);

try {
  // ── 1. STRUCTURE: a driver that never settles still writes exactly one
  // document, exits 30, and names what stopped.
  {
    const repo = await mkdtemp(join(tmpRoot, "wedge-"));
    const captured: string[] = [];
    const code = await withResultGuarantee({
      json: true,
      repoRoot: repo,
      issues: [1863],
      write: (s) => captured.push(s),
      // THE FIELD SHAPE: the driver never answers. Nothing here simulates a
      // crash — the process is alive and simply has no result to give.
      work: () => new Promise(() => undefined),
      wedgeMs: 50,
    });
    const lines = docs(captured.join(""));
    assert(
      captured.length === 1 && lines.length === 1,
      `a run whose driver NEVER settles still writes exactly one result document (got ${captured.length} write(s) / ${lines.length} line(s) — the bug wrote zero)`,
    );
    assert(
      code === EXIT.crash,
      `a wedged run exits 30, the honest code for a driver that never answered (got ${code})`,
    );
    const doc = JSON.parse(lines[0] as string) as {
      exitCode?: number;
      error?: { code?: string; message?: string };
      issues?: Array<{ issue: number; status: string }>;
    };
    assert(
      doc.error?.code === "driver-wedged",
      `the wedge names the driver as what stopped, never a bare 'exited 0 without a result' (error=${JSON.stringify(doc.error)})`,
    );
    assert(
      doc.exitCode === EXIT.crash && code === doc.exitCode,
      `the document's exitCode and the process exit code agree (${doc.exitCode} vs ${code})`,
    );
    assert(
      Array.isArray(doc.issues) && doc.issues.some((i) => i.issue === 1863),
      `the wedged run still projects the issue it was asked about, from its state file (issues=${JSON.stringify(doc.issues?.map((i) => [i.issue, i.status]))})`,
    );
  }

  // ── 2. A run that DOES settle writes exactly one document and keeps its code.
  {
    const repo = await mkdtemp(join(tmpRoot, "ok-"));
    const captured: string[] = [];
    const code = await withResultGuarantee({
      json: true,
      repoRoot: repo,
      issues: [7],
      write: (s) => captured.push(s),
      work: async () => ({ exitCode: EXIT.merged, results: [], error: undefined }),
      wedgeMs: 5_000,
    });
    assert(
      docs(captured.join("")).length === 1 && code === EXIT.merged,
      `a settled run writes exactly one document and keeps its own exit code (${docs(captured.join("")).length} doc, exit ${code})`,
    );
    const doc = JSON.parse(docs(captured.join(""))[0] as string) as { error?: unknown };
    assert(
      doc.error === undefined,
      `a settled run is not reported as wedged (error=${JSON.stringify(doc.error)})`,
    );
  }

  // ── 3. The wedge projection distinguishes "no state file" from a real state.
  {
    const repo = await mkdtemp(join(tmpRoot, "state-"));
    await mkdir(join(repo, ".pi", "work-state"), { recursive: true });
    const state = initialState(1863);
    state.pipelineState.status = "handoff";
    await writeFile(
      join(repo, ".pi", "work-state", "1863.json"),
      JSON.stringify({ ...state, eventLog: [] }),
    );
    const run = await wedgedRun(repo, [1863, 4242], "test");
    const handoff = run.results.find((r) => r.issue === 1863);
    const missing = run.results.find((r) => r.issue === 4242);
    assert(
      handoff?.status !== "not-started",
      `an issue whose state file is readable is projected from it (status=${handoff?.status}; a handoff state must not read not-started)`,
    );
    assert(
      missing?.status === "not-started" && missing.exitCode === EXIT.crash,
      `an issue with NO state file is reported not-started at exit 30 — a wedge never claims success (status=${missing?.status} exit=${missing?.exitCode})`,
    );
    assert(
      run.exitCode === EXIT.crash,
      `the wedge run's overall code is 30 (got ${run.exitCode})`,
    );
    assert(
      formatResultDocument(run, false).includes("driver-wedged"),
      "the non-json form names the wedge too — hosts read both",
    );
  }

  // ── 4. END-TO-END: a real `bun cli.ts work` process never exits 0 silently.
  {
    const repo = await mkdtemp(join(tmpRoot, "e2e-"));
    const out = await runCli(["work", "1863", "--json"], { PI_ENSEMBLE_HEADLESS: "1" }, repo);
    const lines = docs(out.stdout);
    assert(
      out.code !== 0 || lines.length > 0,
      `a real runner NEVER exits 0 with an empty stdout — the field symptom (exit=${out.code}, stdout lines=${lines.length}, stderr=${JSON.stringify(out.stderr.slice(0, 80))})`,
    );
    assert(
      lines.length >= 1,
      `the real runner printed its result document (got ${lines.length} line(s))`,
    );
    if (lines.length >= 1) {
      let parsed: { exitCode?: number; issues?: unknown[] } | undefined;
      try {
        parsed = JSON.parse(lines[0] as string);
      } catch {
        parsed = undefined;
      }
      assert(
        parsed !== undefined && Array.isArray(parsed.issues) && typeof parsed.exitCode === "number",
        "the real document is a parseable result document with the per-issue array and a numeric exitCode",
      );
      assert(
        parsed?.exitCode === out.code,
        `the real process exits with the code its document declares (doc ${parsed?.exitCode} vs process ${out.code})`,
      );
    }
  }

  // ── 5. STDOUT OWNERSHIP: only the runner's result writer may write stdout.
  // A second document — from a late wedge racing a healthy run, or from any
  // code path that found `process.stdout.write` itself — would leave the host
  // reading one line and discarding the other, and which one wins depends on
  // the reader. The writer is a latch: the first document is the document, and
  // a later call is refused (#1863 round 1, HIGH/security).
  {
    const repo = await mkdtemp(join(tmpRoot, "latch-"));
    // THE CONTROL first: without the second attempt the stream carries exactly
    // one line, so the case below cannot pass because the run printed nothing.
    const alone = await runCli(["work", "1863", "--json"], {}, repo, latchFixture);
    assert(
      docs(alone.stdout).length === 1,
      `the harness's own run prints one stdout line (got ${docs(alone.stdout).length}) — the control for the latch case`,
    );
    const out = await runCli(
      ["work", "1863", "--json", "--extra-stdout"],
      {},
      repo,
      latchFixture,
    );
    const lines = docs(out.stdout);
    assert(
      lines.length === 1,
      `a SECOND stdout write attempt by the supervisor reaches no document (got ${lines.length} line(s))`,
    );
    assert(
      !out.stdout.includes("SECOND"),
      `the refused document never reaches the host (${JSON.stringify(out.stdout.slice(0, 120))})`,
    );
    assert(
      lines.length === 1 && JSON.parse(lines[0] as string)?.exitCode === out.code,
      "the one line the host reads is the runner's document, and its code is the process code",
    );
    assert(
      out.stderr.includes("refused a second stdout result document"),
      `the refusal is traced rather than silent (stderr tail ${JSON.stringify(out.stderr.slice(-160))})`,
    );
  }

  console.log("OK: #1863 the runner always emits exactly one result document");
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

process.exit(exit);
