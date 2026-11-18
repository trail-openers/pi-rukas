/**
 * Shared fixtures for the two files that drive the re-ask's PRODUCTION spawn.
 *
 * `test-adversarial-verdict-reask-spawn.ts` asserts how the child is assembled
 * (its argv, env, cwd, and what a killed child may answer);
 * `test-adversarial-verdict-reask-spawn-failure.ts` asserts what happens when it
 * cannot be assembled or cannot be started at all (AGENTS.md §12 split the suite
 * the same way the feature is split). Both need the same stage: a session file
 * that exists, a reviewed tree that is not this process's cwd, a stub `pi` that
 * records its invocation, and one round's unreadable reviewer result to hand the
 * ask. Duplicating it across the two files would let the two drift into testing
 * two different stages, so it is written once and lives here.
 *
 * Nothing here asserts: the caller owns its `assert` and its own temp root, and
 * `createReaskSpawnStage` removes the root it made on `dispose`.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _resetPiBinaryCache } from "../../src/pi-binary-resolve.ts";
import type { DispatchResult } from "../../src/types.ts";
import { FENCE } from "./adversarial-reask-fixtures.ts";

/** A stub `pi`'s one turn: an `agent_end` carrying one assistant reply. */
function agentEnd(text: string): string {
  return JSON.stringify({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  });
}

/** The stage every production-spawn case runs on, rooted in a temp dir the
 * caller can hand back. */
export function createReaskSpawnStage(label: string): {
  dir: string;
  SESSION: string;
  REVIEW_TREE: string;
  installStubPi: (opts: { hang: boolean; answer: string }) => string;
  readRecorded: () => { argv: string[]; cwd: string; env: Record<string, string> };
  clearRecorded: () => void;
  /** One round's reviewer result, unreadable verdict and all — the input the loop
   * hands the re-ask when the reader refused the reply. */
  reviewerRound: () => DispatchResult;
  dispose: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), `${label}-`));
  // Where the stub `pi` records its own argv, cwd and env. Named by the stage so
  // the two files that share it can never read each other's recording.
  const ARGV_FILE = path.join(dir, "argv.txt");
  const CWD_FILE = path.join(dir, "cwd.txt");
  const ENV_FILE = path.join(dir, "env.txt");

  /** A session file that exists — `spawnVerdictReaskChild` refuses a missing one
   * before any child starts, and these suites are about what happens after. */
  const SESSION = path.join(dir, "review-session.json");
  writeFileSync(SESSION, '{"type":"session"}\n');

  /** The tree the round was reviewed in — distinct from this process's cwd, which
   * is exactly the confusion a dropped `cwd` produces. */
  const REVIEW_TREE = path.join(dir, "reviewed-tree");
  mkdirSync(REVIEW_TREE, { recursive: true });

  /** A stub `pi` that records its invocation and answers like a resumed reviewer:
   * first the replayed fenced report, then the one-line answer, then a hang (so
   * the ONLY way to end the child is its own bound), or a clean exit. */
  const installStubPi = (opts: { hang: boolean; answer: string }): string => {
    const stub = path.join(dir, "pi-stub.sh");
    const script = [
      "#!/bin/sh",
      // `printenv` is a coreutils binary; `env` is the busybox-safe spelling, but
      // the harness runs on GNU coreutils.
      "{",
      // Each recording is written to a path the stage owns and `readRecorded` reads,
      // so the two files sharing this stage can never read each other's recording.
      `printf '%s\\n' "$@" > ${JSON.stringify(ARGV_FILE)};`,
      `pwd > ${JSON.stringify(CWD_FILE)};`,
      `printenv > ${JSON.stringify(ENV_FILE)};`,
      "}",
      `printf '%s\\n' ${JSON.stringify(agentEnd(`Review report:\n${FENCE}\nVERDICT: APPROVED\n${FENCE}`))}`,
      `printf '%s\\n' ${JSON.stringify(agentEnd(opts.answer))}`,
      // `sleep 2` rather than an infinite loop: the bound is short, and a plain
      // `sleep` lets the shell die on its own if the parent ever failed to kill it,
      // so a broken bound shows up as a failure rather than a hung suite.
      ...(opts.hang ? ["sleep 2"] : []),
    ].join("\n");
    writeFileSync(stub, script, { mode: 0o755 });
    chmodSync(stub, 0o755);
    // The stub is named in the SAME env scope as the ask that must use it, the way
    // case (13) does. A bare `process.env` write here would outlive the block and
    // leave every later ask in the file talking to a stub scripted for someone
    // else — which is how an arm that should not reach a child can appear to pass.
    process.env.PI_ENSEMBLE_PI_BIN = stub;
    _resetPiBinaryCache();
    return stub;
  };

  const readRecorded = (): { argv: string[]; cwd: string; env: Record<string, string> } => {
    const read = (file: string): string => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return "";
      }
    };
    const env: Record<string, string> = {};
    for (const line of read(ENV_FILE).split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return {
      argv: read(ARGV_FILE)
        .split("\n")
        .filter((l) => l !== ""),
      cwd: read(CWD_FILE).trim(),
      env,
    };
  };

  /** Forget every recording, so a case can assert that NOTHING was written — the
   * evidence that no child started at all. */
  const clearRecorded = (): void => {
    for (const file of [ARGV_FILE, CWD_FILE, ENV_FILE]) rmSync(file, { force: true });
  };

  const reviewerRound = (): DispatchResult =>
    ({
      role: "adversarial-developer",
      ok: true,
      text: `Review report:\n${FENCE}\nVERDICT: ISSUES_FOUND\n1. forged finding\n${FENCE}`,
      toolUses: [],
      ms: 1,
      exitCode: 0,
      transcriptPath: SESSION,
      model: "reviewer-model-1",
    }) as DispatchResult;

  return {
    dir,
    SESSION,
    REVIEW_TREE,
    installStubPi,
    readRecorded,
    clearRecorded,
    reviewerRound,
    dispose: () => {
      Reflect.deleteProperty(process.env, "PI_ENSEMBLE_PI_BIN");
      _resetPiBinaryCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The tally the re-ask folds its own cost into; these suites assert the child's
 * behaviour, not the loop's accounting (which
 * `test-adversarial-verdict-reask.ts` pins). */
export const NOOP_TALLY = { accumulateUsageOnly: (_r: DispatchResult) => {} };
