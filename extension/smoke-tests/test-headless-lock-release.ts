#!/usr/bin/env bun
/**
 * #1024 (headless S4) — a signal exit leaves no integration lockfile behind.
 * A held lock is the file a killed runner would leave; releaseHeldIntegrationLocks
 * is what the runner calls before process.exit, and a second runner must then
 * acquire the same lock without waiting out the stale window.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __resetIntegrationLock,
  releaseHeldIntegrationLocks,
  withIntegrationLock,
} from "../src/work-driver-lock.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const repo = mkdtempSync(path.join(tmpdir(), "headless-lock-release-"));
mkdirSync(path.join(repo, ".git"));
const lockFile = path.join(repo, ".git", "pi-rukas-integration.lock");

__resetIntegrationLock();
let finish: () => void = () => {};
const held = withIntegrationLock(
  repo,
  () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
);
const deadline = Date.now() + 5_000;
while (!existsSync(lockFile) && Date.now() < deadline) await sleep(10);
assert(existsSync(lockFile), "the integration lockfile is held by the in-flight run");

// Simulated SIGTERM: the runner releases what it holds before exiting.
releaseHeldIntegrationLocks();
assert(!existsSync(lockFile), "after the signal release the lockfile is gone");

// A second runner (fresh in-process chain, same repo) acquires the lock at once.
__resetIntegrationLock();
const second = await Promise.race([
  withIntegrationLock(repo, async () => "acquired"),
  sleep(3_000).then(() => "blocked"),
]);
assert(second === "acquired", "a second runner acquires the lock immediately");
assert(!existsSync(lockFile), "the second runner's release leaves no lockfile");

finish();
await held;
rmSync(repo, { recursive: true, force: true });
process.exit(exit);
