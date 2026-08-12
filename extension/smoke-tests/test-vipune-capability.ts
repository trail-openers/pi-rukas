#!/usr/bin/env bun
/**
 * The seam's two capability gaps, measured against the real binary.
 *
 * ## 1. The write side could not reach the read side
 *
 * `vipuneSearch` passed no `--status`, so vipune defaulted to `active` — while
 * every write this driver makes is a `candidate`. **100% of what it stored was
 * invisible to its own reads.** Two lines of argv, and nothing downstream
 * worked without it.
 *
 * ## 2. Staleness had nowhere to be resolved
 *
 * A retrieved memory is a claim about a codebase that has since changed, and
 * two contradictory rows about the same subject retrieve at *similar* scores —
 * which is exactly why the score cannot separate them. The durable fix is
 * `--supersedes` at write time; `preferNewest` is the read-side backstop for
 * rows already in the store.
 *
 * Note what is deliberately NOT done: recency is never mixed into the score.
 * vipune's own `--recency` default is what made retrieval useless (see
 * `test-vipune-argv.ts`) — the recency term spans `w` while a hybrid top-5
 * spans ~0.044, so blending replaces the ranking rather than weighting it.
 * `created_at` orders a tie and nothing more.
 *
 * The live half needs the binary; it is skipped when absent unless
 * `PI_ENSEMBLE_VIPUNE_REQUIRED=1`, in which case it fails.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type MemoryHit, preferNewest, searchArgv, vipuneSearch } from "../src/vipune.ts";

const execFileAsync = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ----------------------------------------------------- argv (offline, always)

{
  const plain = searchArgv("x", { cwd: "/x" });
  assert(
    !plain.includes("--include-candidates"),
    "candidates are opt-in — the default read matches vipune's own default",
  );
  const withCand = searchArgv("x", { cwd: "/x", includeCandidates: true });
  assert(
    withCand.includes("--include-candidates"),
    "includeCandidates threads the first-class boolean",
  );
  assert(
    !withCand.some((a) => a.includes(",")),
    "...and never a comma-joined --status list, which degrades silently on a typo",
  );
}

// ------------------------------------------- preferNewest (offline, always)

{
  const hit = (id: string, content: string, created_at?: string): MemoryHit => ({
    id,
    content,
    similarity: 0.8,
    created_at,
  });

  const old = hit(
    "a",
    "The spawn cap is 12 concurrent children by default",
    "2026-01-01T00:00:00Z",
  );
  const recent = hit("b", "The spawn cap is now 16 concurrent children", "2026-08-01T00:00:00Z");

  const kept = preferNewest([old, recent], "fact");
  assert(kept.length === 1, "two contradictory facts about one subject collapse to one");
  assert(
    kept[0]?.id === "b",
    "...and the NEWER one is what survives — your case, deterministically",
  );

  assert(preferNewest([recent, old], "fact")[0]?.id === "b", "...regardless of retrieval order");

  // Guards are hazards, not statements of current fact: two guards about one
  // file are usually two distinct hazards and both must survive.
  assert(
    preferNewest([old, recent], "guard").length === 2,
    "guards are NOT collapsed — age is weak evidence against a hazard",
  );

  // Not vacuous: unrelated rows are never collapsed.
  const unrelated = hit(
    "c",
    "Docs must ship in the same PR as the behaviour",
    "2026-08-05T00:00:00Z",
  );
  assert(
    preferNewest([old, unrelated], "fact").length === 2,
    "unrelated memories are left alone (the collapse is not indiscriminate)",
  );

  // An undated row must not displace a dated one — absence of a date is not recency.
  const undated = hit("d", "The spawn cap is 12 concurrent children by default");
  const r = preferNewest([recent, undated], "fact");
  assert(r.length === 1 && r[0]?.id === "b", "an undated duplicate never displaces a dated one");
}

// --------------------------------------------------- live: the closed loop

const haveVipune = await execFileAsync("sh", ["-c", "command -v vipune"])
  .then(() => true)
  .catch(() => false);

if (!haveVipune) {
  const required = process.env.PI_ENSEMBLE_VIPUNE_REQUIRED === "1";
  console.log(required ? "✗ vipune absent and REQUIRED" : "… vipune absent — skipping live half");
  if (required) exit = 1;
} else {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-vipune-cap-"));
  const db = path.join(tmp, "probe.db");
  const proj = "probe-capability";
  const run = (args: string[]) =>
    execFileAsync("vipune", ["--db-path", db, "-p", proj, ...args], { maxBuffer: 4 * 1024 * 1024 });

  await run([
    "add",
    "spawn-semaphore.ts caps concurrent children at twelve",
    "--memory-type",
    "guard",
  ]);
  await run([
    "add",
    "spawn-semaphore.ts queues excess dispatches FIFO and never rejects",
    "--memory-type",
    "guard",
    "--status",
    "candidate",
  ]);

  const opts = { cwd: tmp, binary: "vipune", timeoutMs: 20_000 } as const;
  // The seam takes cwd for project detection; point it at the probe DB instead.
  const env = { ...process.env, VIPUNE_DB_PATH: db, VIPUNE_PROJECT: proj };
  const exec = async (
    file: string,
    args: string[],
    o: { cwd: string; timeout: number; maxBuffer: number },
  ) => {
    const { stdout, stderr } = await execFileAsync(file, ["--db-path", db, "-p", proj, ...args], {
      ...o,
      env,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  };

  const active = await vipuneSearch("spawn semaphore children", { ...opts, execFn: exec });
  const both = await vipuneSearch("spawn semaphore children", {
    ...opts,
    execFn: exec,
    includeCandidates: true,
  });

  const nActive = active.kind === "hits" ? active.hits.length : -1;
  const nBoth = both.kind === "hits" ? both.hits.length : -1;

  assert(nActive === 1, `the default read sees only the ACTIVE row (${nActive})`);
  assert(nBoth === 2, `--include-candidates sees both (${nBoth}) — this is the loop that was open`);
  assert(
    nBoth > nActive,
    "canary: without includeCandidates every candidate write is invisible to its own read",
  );

  if (both.kind === "hits") {
    assert(
      both.hits.every((h) => typeof h.created_at === "string" && h.created_at.length > 0),
      "every hit carries created_at — the field the seam used to discard",
    );
  }

  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
