#!/usr/bin/env bun
/**
 * #1591 — a headless `work` run's result survives a runner that dies.
 *
 *   - A child that writes its result: passed through unchanged, with its code.
 *   - A child that aborts natively without a result (what Bun does when a
 *     container hits `pids.max`): the supervisor still writes one `--json`
 *     document, `error.code: "crash"`, exit 30, each issue projected from its
 *     state file (`not-started` without one).
 *   - Without `--json`, the summary line and the error line.
 *   - SIGTERM reaches the child, which keeps its own exit code.
 *   - cli.ts routes `work` through the supervisor unless SUPERVISED_ENV is set.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SUPERVISED_ENV, superviseWork } from "../src/headless/supervise.ts";
import { writeState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state-update.ts";

let exit = 0;
function assert(cond: boolean, msg: string, actual?: unknown) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}${actual !== undefined ? ` (got ${JSON.stringify(actual)})` : ""}`);
    exit = 1;
  }
}

const repoRoot = mkdtempSync(path.join(os.tmpdir(), "headless-supervise-"));
const bun = process.execPath;
try {
  await writeState(repoRoot, initialState(345));

  // ── a child with a result is passed through.
  {
    let out = "";
    const code = await superviseWork({
      repoRoot,
      issues: [345],
      json: true,
      command: [bun, "-e", `process.stdout.write('{"exitCode":10}\\n'); process.exit(10)`],
      write: (s) => {
        out += s;
      },
    });
    assert(code === 10 && out === '{"exitCode":10}\n', "a written result passes through", {
      code,
      out,
    });
  }

  // ── a child that aborts without a result.
  {
    let out = "";
    const code = await superviseWork({
      repoRoot,
      issues: [345, 346],
      json: true,
      command: [bun, "-e", "process.abort()"],
      write: (s) => {
        out += s;
      },
    });
    const lines = out.trim().split("\n");
    const doc = JSON.parse(lines[0] ?? "{}");
    assert(code === 30 && doc.exitCode === 30, "an aborted runner exits 30", { code, doc });
    assert(lines.length === 1, "exactly one JSON document on stdout", lines.length);
    assert(
      doc.error?.code === "crash" && /SIGABRT/.test(doc.error?.message ?? ""),
      "error.code crash names the signal",
      doc.error,
    );
    const [a, b] = doc.issues ?? [];
    assert(
      a?.issue === 345 && a.status === "running" && a.exitCode === 30,
      "an issue with a state file is projected from it",
      a,
    );
    assert(
      b?.issue === 346 && b.status === "not-started" && b.exitCode === 30,
      "an issue with no state file is not-started",
      b,
    );
    assert(
      typeof doc.schemaVersion === "number" && doc.resources?.limits !== undefined,
      "the document carries the schema version and resources",
    );
  }

  // ── without --json.
  {
    let out = "";
    await superviseWork({
      repoRoot,
      issues: [345],
      json: false,
      command: [bun, "-e", "process.exit(3)"],
      write: (s) => {
        out += s;
      },
    });
    assert(
      out.includes("#345 running (exit 30)") && out.includes("exited 3 without a result"),
      "the plain summary names each issue and how the runner ended",
      out,
    );
  }

  // ── SIGTERM is forwarded and the child keeps its exit code.
  {
    let out = "";
    const child = [
      "process.on('SIGTERM', () => { process.stdout.write('interrupted\\n'); process.exit(21); });",
      "process.stdout.write('');",
      "setTimeout(() => {}, 10_000);",
    ].join("");
    const run = superviseWork({
      repoRoot,
      issues: [345],
      json: false,
      command: [bun, "-e", child],
      write: (s) => {
        out += s;
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    process.kill(process.pid, "SIGTERM");
    const code = await run;
    assert(code === 21 && out === "interrupted\n", "SIGTERM reaches the child", { code, out });
  }

  // ── cli.ts wiring.
  {
    const cli = readFileSync(path.join(import.meta.dirname, "../src/headless/cli.ts"), "utf8");
    assert(
      cli.includes(`process.env[SUPERVISED_ENV] !== "1"`) && cli.includes("superviseWork("),
      "cli.ts supervises work unless SUPERVISED_ENV is set",
    );
    assert(SUPERVISED_ENV === "PI_ENSEMBLE_HEADLESS_SUPERVISED", "the documented env name");
  }
} finally {
  rmSync(repoRoot, { recursive: true, force: true });
}

process.exit(exit);
