#!/usr/bin/env bun
/**
 * #2031 AC2 — for a REVIEWER-role child the operator-config guard lists the
 * top-level entries of $HOME before and after the child and adds one line per
 * NEW entry, worded `<name> created in $HOME during the <role> run`, to the
 * same `DispatchResult.operatorConfig` array and the same `traceWarn` channel
 * the git/gh restore already uses. It never deletes anything and never changes
 * `ok` or any verdict; a non-reviewer role gets no $HOME line at all.
 *
 * The role gate is `isReviewerRole` (review-bounds.ts), so "not a reviewer line"
 * is a real negative control, not a second hand-kept list. Every case threads a
 * `mkdtemp` sentinel HOME through the env the guard reads — the operator's real
 * home is never opened, which is the incident this issue is about.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withOperatorConfigGuard } from "../src/spawn-operator-config.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";

const SELF = "test-AC2-home-entries-reported.ts";
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
function drainWarns(): string {
  const seen = errWrites;
  errWrites = [];
  return seen.join("");
}

function result(): DispatchResult {
  return { role: "developer", ok: true, text: "done", toolUses: [], ms: 1, exitCode: 0 };
}

/** A sentinel home with one entry (`keep.txt`) that must NEVER be reported. */
function sentinelHome(tag: string): { root: string; home: string; env: Record<string, string> } {
  const root = mkdtempSync(path.join(tmpdir(), `pi-2031-${tag}-`));
  const home = path.join(root, "home");
  mkdirSync(path.join(home, ".config"), { recursive: true });
  writeFileSync(path.join(home, "keep.txt"), "operator's own\n");
  return { root, home, env: { HOME: home } };
}

// --- AC2: a reviewer child's new top-level entry is reported, in both channels

{
  const { home, env } = sentinelHome("reviewer");
  let res: DispatchResult | undefined;
  await withEnv(env, async () => {
    res = await withOperatorConfigGuard("code-review-specialist", async () => {
      writeFileSync(path.join(home, "probe.txt"), "hostile gitconfig probe\n");
      return result();
    });
  });
  const warns = drainWarns();
  const lines = res?.operatorConfig ?? [];
  const homeLines = lines.filter((l) => l.includes("created in $HOME"));
  assert(
    existsSync(path.join(home, "probe.txt")),
    "AC2: the guard deletes nothing — the child's entry is still there to be reported",
  );
  assert(
    homeLines.length === 1,
    `AC2: operatorConfig carries exactly one $HOME line for the new entry (got ${JSON.stringify(lines)})`,
  );
  assert(
    homeLines[0] === "probe.txt created in $HOME during the code-review-specialist run",
    `AC2: the line is worded "<name> created in $HOME during the <role> run" (got ${JSON.stringify(homeLines[0] ?? "")})`,
  );
  assert(
    warns.includes("probe.txt created in $HOME during the code-review-specialist run"),
    "AC2: the same line reaches the traceWarn channel",
  );
  assert(res?.ok === true, "AC2: the disclosure never changes ok");
  assert(
    !lines.some((l) => l.includes("keep.txt")),
    "AC2: an entry that was already there is not reported",
  );
}

// --- AC2 negative control: the same new entry under a non-reviewer role

{
  const { home, env } = sentinelHome("developer");
  let res: DispatchResult | undefined;
  await withEnv(env, async () => {
    res = await withOperatorConfigGuard("developer", async () => {
      writeFileSync(path.join(home, "probe.txt"), "not a reviewer\n");
      return result();
    });
  });
  const warns = drainWarns();
  assert(
    !(res?.operatorConfig ?? []).some((l) => l.includes("created in $HOME")),
    `AC2: a developer child's new $HOME entry is NOT reported (got ${JSON.stringify(res?.operatorConfig ?? [])})`,
  );
  assert(
    !warns.includes("created in $HOME"),
    "AC2: and nothing reaches traceWarn for a non-reviewer role",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
