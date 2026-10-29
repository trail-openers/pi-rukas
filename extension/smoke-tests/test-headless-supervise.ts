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
 *
 * Which bytes of a text-mode stream the host reads (the prose whitelist and the
 * byte-exact document line) are `test-headless-supervise-prose.ts`; the last
 * block below asserts that suite still exists.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "../src/headless/exit-code.ts";
import { RESULT_SCHEMA_VERSION } from "../src/headless/result.ts";
import { SUPERVISED_ENV, parseResultDocument, superviseWork } from "../src/headless/supervise.ts";
import { initialState } from "../src/workflow-state-update.ts";
import { writeState } from "../src/workflow-state.ts";

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
/** The result-document lines on a stream — the host's JSON contract. */
const docs = (out: string): string[] =>
  out.split("\n").filter((l) => l.trim().startsWith("{") && l.includes('"schemaVersion"'));
try {
  await writeState(repoRoot, initialState(345));

  // ── a child with a result is passed through.
  // The document reaches the child as an ARGV element, never as an inline
  // literal: `bun -e <script> <arg>` puts extra args at the END of argv (index
  // 2 is undefined there), and an inline JSON literal in this file came back
  // through the supervisor rewritten by the quoting layers between here and the
  // child. Passing it through keeps the assertion about the BYTES the host
  // reads, which is the whole contract ("the result is the contract, the state
  // file is not", #1326).
  {
    let out = "";
    const doc = JSON.stringify({ schemaVersion: 5, exitCode: 10, issues: [] });
    const code = await superviseWork({
      repoRoot,
      issues: [345],
      json: true,
      command: [
        bun,
        "-e",
        "process.stdout.write(process.argv[process.argv.length - 1] + String.fromCharCode(10)); process.exit(10)",
        doc,
      ],
      write: (s) => {
        out += s;
      },
    });
    assert(
      code === 10 && out.trim() === doc,
      "a written result passes through, with the code the document carries",
      { code, out },
    );
  }

  // ── #1863 AC5: a COMPLETE document the child printed, then a non-zero exit,
  // is forwarded verbatim with the document's own code. This is what the wedge
  // backstop (ensure-result.ts) actually does: print one `driver-wedged`
  // document whose own exitCode is 30, then exit non-zero. The supervisor's
  // first shape keyed the passthrough on "stdout was not empty" and returned
  // the CHILD's exit code, so a runner torn down before its code reached the
  // parent got the supervisor's own crash/30 written over the diagnosis the host
  // needed. The crash projection stays exactly where it was: a child that
  // printed nothing, or only garbage, gets crash/30 (the two cases below).
  {
    let out = "";
    const doc = JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      buildCommit: null,
      buildVersion: "0.0.0-test",
      exitCode: 30,
      issues: [{ issue: 345, status: "handoff", stateFile: "/dev/null", exitCode: 30 }],
      error: { code: "driver-wedged", message: "the run produced no result (wedge)" },
    });
    const code = await superviseWork({
      repoRoot,
      issues: [345],
      json: true,
      command: [
        bun,
        "-e",
        "process.stdout.write(process.argv[process.argv.length - 1] + String.fromCharCode(10)); process.exit(3)",
        doc,
      ],
      write: (s) => {
        out += s;
      },
    });
    const parsed = JSON.parse(out.trim()) as {
      exitCode?: number;
      error?: { code?: string };
    };
    assert(
      code === 30 && parsed.exitCode === 30 && parsed.error?.code === "driver-wedged",
      "a complete result document survives the child's non-zero exit (no crash overwrite)",
      { code, out },
    );
    assert(out === `${doc}\n`, "the child's document is forwarded verbatim, not re-projected", out);
  }

  // ── #1863 AC5 the other way: output that is not a document still crashes.
  {
    let out = "";
    const code = await superviseWork({
      repoRoot,
      issues: [345],
      json: true,
      command: [
        bun,
        "-e",
        "process.stdout.write(process.argv[process.argv.length - 1]); process.exit(1)",
        "a partial line that is not a document",
      ],
      write: (s) => {
        out += s;
      },
    });
    const lines = out.trim().split("\n");
    const crash = JSON.parse(lines[0] ?? "{}");
    assert(
      code === 30 && crash.error?.code === "crash",
      "a child that printed only garbage still gets the crash projection",
      { code, out },
    );
    assert(lines.length === 1, "and the garbage is not passed through alongside it", lines.length);
  }

  // ── #1863 adversarial round: a child that PRINTS a healthy document and is
  // then killed is a crash, not the document. A process that was SIGKILLed
  // cannot vouch for what it wrote, and reporting exit 0 / `merged` for a
  // killed runner is the lie #1591 exists to prevent. The docs
  // (headless.md, troubleshooting.md) promise crash + the signal.
  {
    let out = "";
    const doc = JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      exitCode: 0,
      issues: [{ issue: 345, status: "merged", stateFile: "/dev/null", exitCode: 0 }],
    });
    const code = await superviseWork({
      repoRoot,
      issues: [345],
      json: true,
      command: [
        bun,
        "-e",
        "process.stdout.write(process.argv[process.argv.length - 1] + String.fromCharCode(10)); process.kill(process.pid, 'SIGKILL')",
        doc,
      ],
      write: (s) => {
        out += s;
      },
    });
    const lines = out.trim().split("\n");
    const crash = JSON.parse(lines[0] ?? "{}");
    assert(
      code === 30 && crash.exitCode === 30 && crash.error?.code === "crash",
      "a child killed by a signal after printing a valid exit-0 document is a crash, not a pass",
      { code, out },
    );
    assert(
      /SIGKILL/.test(crash.error?.message ?? ""),
      "and the crash names the signal it died by",
      crash.error,
    );
    assert(
      lines.length === 1 && !(out.includes('"status":"merged"') && out.includes('"error"')),
      "the killed child's own document is not forwarded alongside the crash",
      out,
    );
  }

  // ── #1863 adversarial round: only the document LINE reaches the host, so a
  // child that printed stray bytes first still yields exactly one JSON document.
  {
    let out = "";
    const doc = JSON.stringify({ schemaVersion: RESULT_SCHEMA_VERSION, exitCode: 10, issues: [] });
    const code = await superviseWork({
      repoRoot,
      issues: [345],
      json: true,
      command: [
        bun,
        "-e",
        "process.stdout.write('warning: stray bytes' + String.fromCharCode(10) + process.argv[process.argv.length - 1] + String.fromCharCode(10)); process.exit(10)",
        doc,
      ],
      write: (s) => {
        out += s;
      },
    });
    const lines = out.trim().split("\n");
    assert(
      code === 10 && lines.length === 1 && lines[0] === JSON.stringify(JSON.parse(doc)),
      "in --json mode stray bytes ahead of the document are not forwarded — stdout carries one document",
      { code, out },
    );
  }

  // ── #1863 adversarial round: an exitCode outside the published set is not a
  // result, so the child cannot make the supervisor report a code the CLI never
  // publishes (Infinity, a float, a negative, or an unknown number).
  {
    const stray = [7, -1, 1.5, 999, "0"].map((v) => JSON.stringify(v));
    for (const raw of stray) {
      let out = "";
      const code = await superviseWork({
        repoRoot,
        issues: [345],
        json: true,
        command: [
          bun,
          "-e",
          "process.stdout.write(process.argv[process.argv.length - 1] + String.fromCharCode(10)); process.exit(0)",
          `{"schemaVersion":${RESULT_SCHEMA_VERSION},"exitCode":${raw},"issues":[]}`,
        ],
        write: (s) => {
          out += s;
        },
      });
      const doc = JSON.parse(out.trim().split("\n")[0] ?? "{}");
      assert(
        code === 30 && doc.error?.code === "crash",
        `an out-of-set exitCode ${raw} is garbage, not a result`,
        { code, out },
      );
    }
    // Every published code still passes, so the gate above is not over-tight.
    for (const published of Object.values(EXIT)) {
      const doc = JSON.stringify({
        schemaVersion: RESULT_SCHEMA_VERSION,
        exitCode: published,
        issues: [],
      });
      const parsed = parseResultDocument(`${doc}\n`);
      assert(
        parsed?.exitCode === published,
        `the published exit code ${published} is accepted`,
        parsed,
      );
    }
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
      out.startsWith("pi-rukas-headless: #345 running (exit 30)") &&
        out.includes("exited 3 without a result") &&
        docs(out).length === 0,
      "the plain summary names each issue and how the runner ended, with no document on a crash",
      out,
    );
  }

  // ── SIGTERM is forwarded to the child, which ends with its own code.
  // #1863 — the child now announces itself with a complete result document, so
  // the supervisor forwards those bytes and returns the code the document
  // carries. A bare signal exit (no document) is the crash path the block after
  // this one covers, so this case cannot tell "the child kept its code" apart
  // from "the supervisor defaulted to 30" without a document in the stream.
  {
    let out = "";
    const child = [
      "process.on('SIGTERM', () => {",
      "  process.stdout.write(JSON.stringify({ schemaVersion: 5, exitCode: 21, issues: [] }));",
      "  process.exit(21);",
      "});",
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
    assert(
      code === 21 && out.trim().includes('"exitCode":21'),
      "SIGTERM reaches the child, which keeps its own exit code",
      { code, out },
    );
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

  // ── the text-mode prose rules live in their own suite (#1866 follow-up and
  // the lens round-1 fixes): this file owns "did the child answer, and with what
  // code", that one owns WHICH bytes of a text-mode stream the host reads. A
  // refactor that silently deletes it must fail here as well as there.
  {
    const prose = readFileSync(
      path.join(import.meta.dirname, "test-headless-supervise-prose.ts"),
      "utf8",
    );
    assert(
      prose.includes("superviseWork(") &&
        prose.includes("parseResultLine") &&
        prose.includes("proseLinesBefore") &&
        prose.includes("resultDocument("),
      "the prose-forwarding suite exists, exercises the locator and the whitelist, and builds its fixtures with the real resultDocument builder",
    );
  }
} finally {
  rmSync(repoRoot, { recursive: true, force: true });
}

process.exit(exit);
