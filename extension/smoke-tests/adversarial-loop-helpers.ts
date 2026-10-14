#!/usr/bin/env bun
/**
 * Shared seams for the adversarial-loop smoke tests (test-adversarial-tool-guards.ts,
 * test-adversarial-policy-guard.ts, test-review-autonomy.ts,
 * test-adversarial-range-binding.ts). Each test drives the REAL runAdversarialLoop;
 * this module holds the spawn / dispatch-deck / async-jobs-registry mocks and the
 * scratch-git fixture they all repeated.
 *
 * `installLoopSeams` is called from a test body before the module under test is
 * imported. bun's mock.module applies to every import of the mocked path that
 * happens after the call, so it works from here as it did inline. The ledger
 * writer is NOT mocked here: some tests want the real writer.
 */

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SpawnSpec = { role: string; prompt: string; cwd?: string };
export type SpawnHandler = (spec: SpawnSpec) => Promise<unknown>;

/** Install the child-spawn seam (every role routes through `onSpawn`), the dispatch-deck and the registry stubs. */
export async function installLoopSeams(onSpawn: SpawnHandler): Promise<void> {
  mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
    makeRunId: () => "run-loop-seam",
    spawnSpecialist: onSpawn,
  }));
  const realDeck = await import("../src/dispatch-deck.ts");
  mock.module(new URL("../src/dispatch-deck.ts", import.meta.url).href, () => ({
    ...realDeck,
    startEntry: () => {},
    updateEntry: () => {},
    clearEntry: () => {},
    startBatchEntry: () => {},
    updateBatchProgress: () => {},
    clearBatchEntry: () => {},
  }));
  const realRegistry = await import("../src/async-jobs-registry.ts");
  mock.module(new URL("../src/async-jobs-registry.ts", import.meta.url).href, () => ({
    ...realRegistry,
    childHandles: new Map(),
    registerChildHandle: () => {},
    setOrchestratorActiveChild: () => {},
    markOrchestrator: () => {},
  }));
}

/** Run git in `dir` (argv form, no shell). */
export const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });

/** A scratch repo on `main` with one commit and a test identity. `prefix` names the mkdtemp dir. */
export function newRepo(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(path.join(dir, "f.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}
