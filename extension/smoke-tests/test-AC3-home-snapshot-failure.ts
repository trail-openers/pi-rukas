#!/usr/bin/env bun
/**
 * #2031 AC3 — "no baseline is not a change", for the $HOME listing.
 *
 * Two shapes the guard must keep apart, mirroring what `spawn-operator-config.ts`
 * already does for the four protected files:
 *
 *   - the PRE-run listing fails → exactly one `could not snapshot $HOME (<code>)`
 *     line and NO per-entry lines (an unreadable home is not evidence of a child
 *     write, so a child that created entries in it is not accused);
 *   - the POST-run listing fails while a baseline exists → one line naming the
 *     reason (there "cannot read" means "cannot prove unchanged").
 *
 * In both cases the disclosure never deletes anything and never moves `ok`.
 * Unreadability is produced with mode `000` on a `mkdtemp` sentinel HOME under a
 * non-root uid; a root run would ignore the mode bits, so that case is stated
 * rather than pretended.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withOperatorConfigGuard } from "../src/spawn-operator-config.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";

const SELF = "test-AC3-home-snapshot-failure.ts";
const realErrWrite = process.stderr.write.bind(process.stderr);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    realErrWrite(`✗ ${SELF}: ${msg}\n`);
    exit = 1;
  }
}

let errWrites: string[] = [];
process.stderr.write = ((chunk: string | Uint8Array) => {
  errWrites.push(String(chunk));
  return true;
}) as typeof process.stderr.write;
function drainWarns(): string[] {
  const seen = errWrites.flatMap((c) => String(c).split("\n"));
  errWrites = [];
  return seen.filter((l) => l !== "");
}

function result(): DispatchResult {
  return { role: "developer", ok: true, text: "done", toolUses: [], ms: 1, exitCode: 0 };
}

function sentinelHome(tag: string): { home: string; env: Record<string, string> } {
  const root = mkdtempSync(path.join(tmpdir(), `pi-2031-ac3-${tag}-`));
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "keep.txt"), "operator's own\n");
  return { home, env: { HOME: home } };
}

const UNREADABLE = process.getuid !== undefined && process.getuid() !== 0;

// --- the PRE-run listing fails: one snapshot line, no per-entry lines

if (UNREADABLE) {
  const { home, env } = sentinelHome("pre");
  chmodSync(home, 0o000);
  let res: DispatchResult | undefined;
  await withEnv(env, async () => {
    res = await withOperatorConfigGuard("adversarial-developer", async () => result());
  });
  chmodSync(home, 0o755);
  const snapshot = drainWarns().filter((l) => l.includes("could not snapshot $HOME"));
  const lines = res?.operatorConfig ?? [];
  assert(
    snapshot.length === 1 && /could not snapshot \$HOME \(E[A-Z]+\)/.test(snapshot[0] ?? ""),
    `AC3: a failed pre-run listing warns exactly one "could not snapshot $HOME (<code>)" line (${JSON.stringify(snapshot)})`,
  );
  assert(
    !lines.some((l) => l.includes("created in $HOME")),
    `AC3: with no baseline no per-entry line is emitted (got ${JSON.stringify(lines)})`,
  );
  assert(res?.ok === true, "AC3: the disclosure never changes ok");
} else {
  console.log("– AC3 pre-run case skipped: running as root, mode 000 is not unreadable");
}

// --- the POST-run listing fails with a baseline: one line naming the reason

if (UNREADABLE) {
  const { home, env } = sentinelHome("post");
  let res: DispatchResult | undefined;
  await withEnv(env, async () => {
    res = await withOperatorConfigGuard("adversarial-developer", async () => {
      // The child's last act: make its own home unreadable, so the guard has a
      // baseline and cannot prove the top level is unchanged.
      chmodSync(home, 0o000);
      return result();
    });
  });
  chmodSync(home, 0o755);
  // Only the $HOME check's own lines: the protected-file lines carry absolute
  // paths and are the guard's pre-existing behaviour, not this check.
  const homeLines = drainWarns().filter((l) => l.includes("$HOME"));
  const lines = res?.operatorConfig ?? [];
  assert(
    existsSync(path.join(home, "keep.txt")),
    "AC3: the guard deletes nothing when the post-run listing fails",
  );
  assert(
    homeLines.length === 1 &&
      /E[A-Z]+/.test(homeLines[0] ?? "") &&
      !homeLines[0]?.includes("created in $HOME"),
    `AC3: a failed post-run listing with a baseline warns one line naming the reason (${JSON.stringify(homeLines)})`,
  );
  assert(
    !lines.some((l) => l.includes("created in $HOME")),
    `AC3: a home the guard cannot read yields no per-entry lines (got ${JSON.stringify(lines)})`,
  );
  assert(res?.ok === true, "AC3: and the disclosure still never changes ok");
} else {
  console.log("– AC3 post-run case skipped: running as root, mode 000 is not unreadable");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
