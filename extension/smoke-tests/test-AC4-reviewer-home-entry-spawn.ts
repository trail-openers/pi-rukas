#!/usr/bin/env bun
/**
 * #2031 AC4 — the offline end-to-end view: a REAL reviewer child through the
 * real `spawnSpecialist` (stub child process, no Pi, no model, no tokens) whose
 * run creates an entry at the top level of a `mkdtemp` sentinel $HOME is
 * reported, one line per new entry, on `DispatchResult.operatorConfig`.
 *
 * Four observations, in order:
 *   1. a reviewer child's new entry is reported, and `ok` is unchanged;
 *   2. an unchanged home reports nothing;
 *   3. a developer child's new entry is NOT reported (the check is gated on
 *      `isReviewerRole`, review-bounds.ts — not a second role list);
 *   4. the gate is observed red on the mutant "compare step skipped": a run
 *      whose child writes $HOME with no before/after comparison in the picture
 *      leaves the entry and reports nothing, so case 1's line is the difference
 *      the comparison makes.
 *
 * `stub.body` runs at the moment the child's process is created, which is inside
 * the guard's window; the sentinel HOME is threaded through the same env the
 * spawn hands the child (an ambient `process.env` assignment would not reach the
 * child — bun does not write env mutations back to the real environ).
 */

// Must stay first: points the role prompts at a test-owned dir before src/roles.ts
// resolves them at module load, so AC4 never reads `<repo>/dist/prompts/standard/*`
// that a sibling test's build.sh is replacing under it (#1579, same helper as
// test-cancel.ts).
import "./lib/cancel-prompts.ts";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeEntries, homeNewEntryLines } from "../src/home-watch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";
import { installStubChild } from "./lib/reviewer-child-stub.ts";

const SELF = "test-AC4-reviewer-home-entry-spawn.ts";
isolateLedger();
// The child is a `node` stub, never a Pi process, but the dispatch reaches the
// real `child_process.spawn` seam the suite forbids by default.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";
const gitEnv = gitTestEnv();
const stub = installStubChild(gitEnv);

const realErrWrite = process.stderr.write.bind(process.stderr);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    realErrWrite(`✗ ${SELF}: ${msg}\n`);
    exit = 1;
  }
}

const { spawnSpecialist } = await import("../src/spawn.ts");

/** A scratch repo dir to hand the child as `cwd` (a non-repo dir keeps the
 * reviewer tree relocation out of the way so `stub.body` runs in the cwd). */
function workDir(tag: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `pi-2031-ac4-${tag}-`));
}

/** Run one dispatch whose child creates `name` at the top level of `home`. */
async function dispatchWithProbe(role: string, home: string, name: string | null) {
  stub.body =
    name === null ? undefined : () => void writeFileSync(path.join(home, name), "probe\n");
  const res = await spawnSpecialist({ role, prompt: "review", cwd: workDir(role) }, {});
  stub.body = undefined;
  return res;
}

// 1 — a reviewer child's new entry is reported; ok is untouched
{
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-2031-ac4-rhome-"));
  mkdirSync(path.join(home, ".pi"), { recursive: true });
  let res = undefined as Awaited<ReturnType<typeof spawnSpecialist>> | undefined;
  await withEnv({ HOME: home }, async () => {
    res = await dispatchWithProbe("code-review-specialist", home, "probe.txt");
  });
  const lines = (res?.operatorConfig ?? []).filter((l) => l.includes("created in $HOME"));
  assert(
    res?.ok === true,
    `AC4: the reviewer dispatch still succeeded (${res?.parseError ?? "ok"})`,
  );
  assert(
    existsSync(path.join(home, "probe.txt")),
    "AC4: the child really created the entry (the guard deletes nothing)",
  );
  assert(
    lines.length === 1 &&
      lines[0]?.startsWith("probe.txt created in $HOME during the code-review-specialist run"),
    `AC4: one line names the new entry and the role (got ${JSON.stringify(res?.operatorConfig ?? [])})`,
  );
}

// 2 — an unchanged home reports nothing
{
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-2031-ac4-clean-"));
  writeFileSync(path.join(home, "keep.txt"), "operator's own\n");
  let res: Awaited<ReturnType<typeof spawnSpecialist>> | undefined;
  await withEnv({ HOME: home }, async () => {
    res = await dispatchWithProbe("code-review-specialist", home, null);
  });
  const homeLines = (res?.operatorConfig ?? []).filter((l) => l.includes("created in $HOME"));
  assert(
    homeLines.length === 0,
    `AC4: an unchanged $HOME reports nothing (got ${JSON.stringify(homeLines)})`,
  );
}

// 3 — a developer child's new entry is NOT reported
{
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-2031-ac4-dev-"));
  let res: Awaited<ReturnType<typeof spawnSpecialist>> | undefined;
  await withEnv({ HOME: home }, async () => {
    res = await dispatchWithProbe("developer", home, "probe.txt");
  });
  assert(
    existsSync(path.join(home, "probe.txt")),
    "AC4: the developer child really created the entry",
  );
  const homeLines = (res?.operatorConfig ?? []).filter((l) => l.includes("created in $HOME"));
  assert(
    homeLines.length === 0,
    `AC4: a non-reviewer role gets no $HOME line (got ${JSON.stringify(homeLines)})`,
  );
}

// 4 — the mutant: what the run looks like with the compare step skipped. Following
// the G mutant of test-operator-config-guard.ts: the SAME hostile run (the child
// writes $HOME inside the window, as case 1 does), once with the pre-run listing
// taken and never compared — which is all that is left when the compare step is
// deleted — and once with the guard in place. If this pair ever goes green-to-green,
// case 1 is vacuous too.
{
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-2031-ac4-mutant-"));
  // The mutant: pre-run listing, run the child, return — never compare.
  const mutant = await homeEntries(home);
  await withEnv({ HOME: home }, async () => {
    await dispatchWithProbe("code-review-specialist", home, "probe.txt");
  });
  const lines = homeNewEntryLines("code-review-specialist", mutant, await homeEntries(home));
  assert(
    existsSync(path.join(home, "probe.txt")) && lines.length === 1,
    `AC4 mutant "compare step skipped": an entry made INSIDE the window survives while the only thing missing was the comparison (${JSON.stringify(lines)})`,
  );
  // And the guard's own comparison proves the difference is the compare step, not
  // the fixture.
  const guardHome = mkdtempSync(path.join(os.tmpdir(), "pi-2031-ac4-guard-"));
  let res: Awaited<ReturnType<typeof spawnSpecialist>> | undefined;
  await withEnv({ HOME: guardHome }, async () => {
    res = await dispatchWithProbe("code-review-specialist", guardHome, "probe.txt");
  });
  const reported = (res?.operatorConfig ?? []).filter((l) => l.includes("created in $HOME"));
  assert(
    existsSync(path.join(guardHome, "probe.txt")) && reported.length === 1,
    `AC4: the same run with the guard's comparison in place reports the entry (${JSON.stringify(reported)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
