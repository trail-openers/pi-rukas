#!/usr/bin/env bun
/**
 * Issue #803/#1014 — verify-loop shared helpers.
 *
 * Shared by test-verify-loop.ts (cases 1-8) and
 * test-verify-loop-timeout.ts (cases 9-10) so both run the same loop
 * (smoke-tests/lib/verify-loop.sh) through the same consumer path.
 *
 * runLoop — run the loop with the given fixture files.
 * runLoopEnv — run the loop with an env override (e.g. low
 *   PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S for the timeout cases).
 * runPipeline — full consumer path: loop output → 800-char attributed tail
 *   → specific assertion → consolidated-verify classification.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
  extractSpecificAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = path.join(__dirname, "lib", "verify-loop.sh");

export function runLoop(files: string[]): { status: number; stdout: string } {
  const result = spawnSync("bash", [SCRIPT, ...files], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout };
}

export function runLoopEnv(
  files: string[],
  env: Record<string, string>,
): { status: number; stdout: string } {
  const r = spawnSync("bash", [SCRIPT, ...files], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout };
}

// #827 shared pipeline: verify-loop output → 800-char attributed tail →
// specific assertion → consolidated-verify classification. Both the
// #772-shape (case 6) and multi-failure (case 7) cases go through the FULL
// consumer path so a regression at any seam (loop echo, tail window,
// extractor, classifier) fails there.
export function runPipeline(files: string[]): {
  stdout: string;
  tail: string;
  attributed: boolean;
  assertion: string;
  verdict: ReturnType<typeof classifyConsolidatedVerifyFailure>;
  message: string;
} {
  const { stdout } = runLoop(files);
  const { tail, attributed } = extractAttributedTail(stdout, 800);
  const assertion = extractSpecificAssertion(tail);
  // N>1 with no per-worktree failures — the consolidated-failure consumer
  // shape, so the size-cap trivial-fix branch is reachable in case 6.
  const verdict = classifyConsolidatedVerifyFailure(2, ["a", "b"], tail, {});
  return {
    stdout,
    tail,
    attributed,
    assertion,
    verdict,
    message: consolidatedFailureMessage(verdict, "bun run check"),
  };
}
