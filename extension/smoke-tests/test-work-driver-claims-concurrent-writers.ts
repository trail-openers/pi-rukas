#!/usr/bin/env bun
/**
 * #1454 r2 — concurrent claim writers must not lose a claim.
 *
 * `readClaims` became a WRITER when prune-on-read landed, which made every
 * reader of `.pi/work-state/path-claims.json` a read-modify-write. Two cycles
 * interleaving `read → write → rename` each rebuilt the registry from their own
 * snapshot, so the later rename removed the earlier cycle's just-registered
 * claim. Nothing detected it: the losing cycle believed it held its paths, and
 * the collision surfaced as a `git apply` failure at integration — the exact
 * failure the registry exists to prevent.
 *
 * **Separate processes, not Promise.all in one process.** A same-process
 * "concurrency" test with an in-process mutex passes whether or not the
 * cross-process lock exists, because an `O_EXCL` file lock and a promise chain
 * are indistinguishable to a test that never leaves the process. These children
 * are real `bun` processes racing on the same file.
 *
 * **Mutation-checked.** A second phase repeats the race with the lock forced
 * unavailable (`PI_ENSEMBLE_TEST_CLAIMS_LOCK_BLOCKED`), and asserts a claim IS
 * lost. An assertion that cannot fail when the fix is removed is not a test of
 * the fix.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const WRITER = path.join(import.meta.dirname, "lib", "claims-concurrent-writer.ts");

/**
 * The barrier. Children are spawned together and none writes until the file
 * appears, so the race is a race: without this, bun's ~40ms process startup
 * serialises the children by accident and the test asserts nothing about
 * concurrency.
 */
function gatePath(dir: string): string {
  return path.join(dir, "go");
}

/** One child process that registers a claim and exits. */
function runWriter(dir: string, issue: number, unlocked: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (unlocked) env.PI_ENSEMBLE_TEST_CLAIMS_LOCK_BLOCKED = "1";
    const child = spawn(
      process.execPath,
      ["run", WRITER, dir, String(issue), gatePath(dir)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`writer ${issue} exited ${code}: ${err.slice(0, 400)}`));
      else resolve(code ?? 0);
    });
  });
}

function claimsAt(dir: string): { issue: number }[] {
  const f = path.join(dir, ".pi", "work-state", "path-claims.json");
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(parsed) ? (parsed as { issue: number }[]) : [];
  } catch {
    return [];
  }
}

const WRITERS = 8;

async function race(unlocked: boolean): Promise<number[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-claims-race-"));
  // `.git` must exist. `claimStaleReason` reads the claimant's state file, and
  // a missing `.git` makes that read THROW — which routes every entry to the
  // `unreadable-state` branch and, past the age bound, makes a just-written
  // claim prunable by a sibling. Asserting "no claim is lost" against a tree
  // where the code has a documented reason to delete one tests nothing.
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  try {
    const started = Array.from({ length: WRITERS }, (_, i) => runWriter(dir, 2000 + i, unlocked));
    // Release them together — every child is polling for this file.
    await Bun.write(gatePath(dir), "go\n");
    await Promise.all(started);
    return claimsAt(dir).map((c) => c.issue);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n#1454 r2 — concurrent claim writers (#1454)...");

{
  // Positive: every writer's claim survives the race.
  const survivors = await race(false);
  const missing = Array.from({ length: WRITERS }, (_, i) => 2000 + i).filter(
    (n) => !survivors.includes(n),
  );
  assert(
    missing.length === 0,
    `all ${WRITERS} concurrent claims survive (lost: ${JSON.stringify(missing)})`,
  );
  assert(
    new Set(survivors).size === survivors.length,
    "the registry holds no duplicated entry after the race",
  );
}

{
  // Mutation check: with the lock forced unavailable, the lost update is
  // observable. If this phase ever passes too, the positive assertion above is
  // testing something other than the lock.
  const survivors = await race(true);
  const missing = Array.from({ length: WRITERS }, (_, i) => 2000 + i).filter(
    (n) => !survivors.includes(n),
  );
  assert(
    missing.length > 0,
    `mutation check: with the lock unavailable a claim IS lost (lost: ${JSON.stringify(missing)}) — proves the positive assertion tests the lock`,
  );
}

console.log(exit === 0 ? "\nAll claims-concurrency checks passed." : "\nFAILED");
process.exit(exit);
