#!/usr/bin/env bun
/**
 * The one child process the guard-companion preflight case in `test-lean-review-fixer-bound.ts` runs.
 *
 * A missing guard companion has to be a NAMED dispatch failure rather than a resumed child with none
 * of the mode-independent guards, and the only way to assert that honestly is to make the companion
 * genuinely unresolvable while the call runs. `test-adversarial-verdict-reask-spawn-failure.ts`
 * established the shape for an unreachable fs target: the fault is provoked in a SUBPROCESS, so the
 * real `statSync` of the real path fails for the real reason — no `node:fs` mock, whose ESM namespace
 * is read-only under bun and which would report a pass for the wrong reason.
 *
 * This is that subprocess's body. It answers one JSON line on stdout — how many children were
 * spawned, what outcome the caller read, and whether the trace carried the preflight's NAMED error —
 * and nothing else, so the parent can tell "the arm ran" from "the arm did not". The named error is
 * read from the trace rather than from a thrown exception on purpose: the module's own catch turns
 * that throw into an outcome, and it is the outcome plus the name that together say the companion
 * was missing and said so.
 *
 * `argv[2]` is the companion path, given rather than imported so the two processes agree on ONE
 * path by construction: the file moved here is byte-identical to the one `CHILD_GUARDS_PATH` names
 * there, and the probe cannot move a file the case then checks for.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_GUARDS_PATH } from "../../src/child-guards.ts";
import {
  type ContinuationOutcome,
  spawnDeveloperContinuationChild,
} from "../../src/developer-session-continuation.ts";

const companion = process.argv[2] ?? CHILD_GUARDS_PATH;
// The trace is gated on this switch, and the named companion error only exists in the trace — so the
// probe turns it on for itself rather than inheriting whatever the parent test happened to run with.
process.env.PI_ENSEMBLE_DEBUG = "1";
const hidden = `${companion}.preflight-probe-hidden`;
const moved = spawnSync("mv", [companion, hidden], { stdio: "ignore" });

let crashed = false;
let spawned = false;
let ok = true;
let reason: string | undefined;
let preflightNamed = false;
try {
  if (moved.status !== 0) throw new Error(`the companion could not be moved aside (${moved.status})`);
  const dir = mkdtempSync(join(tmpdir(), "lean-preflight-probe-"));
  const transcriptPath = join(dir, "fixer-session.json");
  writeFileSync(transcriptPath, '{"type":"user","message":"the fixer read this"}\n');
  // The trace is the only place the preflight's NAMED error can be seen: the module's own catch turns
  // the throw into an outcome, so an outcome alone cannot tell a named companion failure from any
  // other preparation fault. Captured on this process's stderr, and reported as one boolean.
  const written: string[] = [];
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => {
    written.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const out: ContinuationOutcome = await spawnDeveloperContinuationChild(
      {
        transcriptPath,
        role: "developer",
        cwd: dir,
        writeFence: { root: dir, repo: dir, scratch: dir },
        boundMs: 1_000,
        prompt: "the probe's one prompt",
      },
      {
        // A spawn here would be the defect: the preflight must fail BEFORE the child exists. The
        // parent asserts on this boolean, so a fake that started a child cannot be read as a refusal.
        spawn: (() => {
          spawned = true;
          throw new Error("the probe must never reach a spawn");
        }) as unknown as typeof import("node:child_process").spawn,
      },
    );
    ok = out.ok;
    if (!out.ok) reason = out.reason;
    preflightNamed = written.some(
      (l) => l.includes("child-guards extension unavailable at") && l.includes("run ./install.sh"),
    );
  } finally {
    process.stderr.write = writeErr;
  }
} catch (err) {
  crashed = true;
  reason = err instanceof Error ? err.message : String(err);
} finally {
  spawnSync("mv", [hidden, companion], { stdio: "ignore" });
}

process.stdout.write(`${JSON.stringify({ spawned, ok, reason, preflightNamed, crashed })}\n`);
