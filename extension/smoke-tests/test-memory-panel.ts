#!/usr/bin/env bun
/**
 * `/audit` gains a memory section — and `memory-stats.ts` gains a caller.
 *
 * It shipped in v0.12.32 calibrated, documented and fully tested, imported by
 * nothing. The second module in this repo to do that, which is why
 * `test-seams-wired.ts` now enforces the general rule.
 *
 * The panel is a bonus on `/audit`, never a reason for it not to run: every
 * failure path yields no panel, and the outgoing message is then byte-identical
 * to the prompt body.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { renderMemoryPanel, resolveProject } from "../src/memory-panel.ts";
import type { MemoryStats } from "../src/memory-stats.ts";

const execp = promisify(exec);

/** The owner/repo slug the current git remote reduces to, or nothing. */
async function expectedSlugFromRemote(): Promise<string | undefined> {
  try {
    const { stdout } = await execp("git config --get remote.origin.url", { cwd: process.cwd() });
    const url = stdout.trim();
    if (!url) return undefined;
    const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const stats = (o: Partial<MemoryStats>): MemoryStats => ({
  project: "trail-openers/pi-rukas",
  rows: 100,
  byStatus: { active: 100 },
  byType: { decision: 60, fix: 40 },
  totalRetrievals: 250,
  maxRetrievals: 12,
  neverRetrieved: 10,
  medianChars: 480,
  ...o,
});

// ------------------------------------------------- findings, not a number dump

{
  const panel = renderMemoryPanel(stats({ neverRetrieved: 74 }));
  assert(/74 of 100/.test(panel), "a mostly-unread store is called out with the counts");
  assert(/74%/.test(panel), "...as a percentage too");
  assert(
    /names the files and symbols/.test(panel),
    "canary: it says what to DO — a bare percentage is not an audit finding",
  );
}

{
  const panel = renderMemoryPanel(
    stats({ totalRetrievals: 0, maxRetrievals: 0, neverRetrieved: 100 }),
  );
  assert(/write-only/.test(panel), "a store nothing reads back is named as write-only");
  assert(/pure cost/.test(panel), "...and the consequence is stated plainly");
}

{
  const panel = renderMemoryPanel(stats({ medianChars: 60 }));
  assert(/60 characters/.test(panel), "very short memories are flagged");
}

{
  const panel = renderMemoryPanel(
    stats({
      rows: 0,
      byStatus: {},
      byType: {},
      totalRetrievals: 0,
      maxRetrievals: 0,
      neverRetrieved: 0,
      medianChars: 0,
    }),
  );
  assert(/No memories recorded/.test(panel), "an empty store says so");
  assert(!/NaN|Infinity/.test(panel), "canary: no division-by-zero artefacts on an empty store");
}

{
  const panel = renderMemoryPanel(stats({ byStatus: { active: 20, archived: 80 } }));
  assert(/80 of 100 rows are archived/.test(panel), "a mostly-archived store is flagged");
}

// ------------------------------------------------ a healthy store stays quiet

{
  const panel = renderMemoryPanel(stats({}));
  assert(/Nothing anomalous/.test(panel), "a healthy store gets one line, not a report");
  assert(panel.split("\n").length <= 6, `...and stays short (${panel.split("\n").length} lines)`);
  assert(/250 retrievals/.test(panel), "the headline numbers are still there");
}

// ------------------------------------------------------- project resolution

{
  const prev = process.env.VIPUNE_PROJECT;
  process.env.VIPUNE_PROJECT = "explicit/name";
  assert(
    (await resolveProject("/nonexistent")) === "explicit/name",
    "VIPUNE_PROJECT wins — an operator who set it meant it",
  );
  process.env.VIPUNE_PROJECT = "";
  const fromGit = await resolveProject(process.cwd());
  // The slug is derived from the ACTUAL git remote rather than hardcoded, so
  // the test passes whether the remote is still `randomm/pi-ensemble` (the
  // GitHub transfer has not happened yet) or has become `trail-openers/pi-rukas`.
  // Both reduce to `owner/repo` via the same regex `resolveProject` uses.
  const expectedSlug = await expectedSlugFromRemote();
  assert(
    expectedSlug !== undefined && fromGit === expectedSlug,
    `falls back to the git remote, reduced to owner/repo (got ${fromGit}, expected ${expectedSlug})`,
  );
  assert(
    (await resolveProject("/")) === undefined,
    "outside a git repo it resolves to nothing — and so renders no panel",
  );
  if (prev === undefined) process.env.VIPUNE_PROJECT = "";
  else process.env.VIPUNE_PROJECT = prev;
}

console.log(`\nexit ${exit}`);
process.exit(exit);
