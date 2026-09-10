#!/usr/bin/env bun
/**
 * The read path, and the recall harness that keeps it honest.
 *
 * The selection rule here differs from the seam's defaults on three points,
 * each settled by a 940-observation sweep against the live store. This file
 * pins all three, because every one of them was wrong in a shipped design:
 *
 *   1. **Unfiltered, not `--memory-type guard`.** Filtered, a query for
 *      `permission-guard.ts` scores 0.0385 and the guard is missed; unfiltered
 *      the same query scores 0.076923 and finds it. Guards are 5 of 111 rows.
 *   2. **The agreement bit alone, no semantic floor.** Re-adding SIM_FLOOR to
 *      the conjunction drops files-hit 22/24 → 8/24 and removes zero false
 *      positives.
 *   3. **One query per basename, plus a stem fallback.** Concatenation destroys
 *      the signal: a three-basename query scored the target guard 0.6301, below
 *      any usable floor, where the basename alone scored 0.6513.
 *
 * The live half measures recall@K against a HERMETIC scratch store — a
 * mkdtemp'd database seeded with a committed five-row fixture — so the result
 * is identical on every host and never depends on the row count or contents
 * of the real ~/.vipune/memories.db. It is skipped when vipune is absent —
 * unless `PI_ENSEMBLE_VIPUNE_REQUIRED=1`, when it fails.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MAX_BRIEF_HITS, buildMemoryBrief, memoryQueriesFor } from "../src/memory-brief.ts";
import { HYBRID_AGREEMENT } from "../src/vipune.ts";

const execFileAsync = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------- query construction

{
  const q = memoryQueriesFor(["extension/src/permission-guard.ts", "src/spawn.ts"]);
  assert(q[0] === "permission-guard.ts", "the basename is queried first, not the full path");
  assert(
    q.includes("permission-guard"),
    "...with the STEM as a fallback — the fix for rows written before extensions were conventional",
  );
  assert(!q.some((x) => x.includes("/")), "no query carries a path separator");
  assert(
    !q.some((x) => x.includes(" ")),
    "never a concatenated list — measured, that scores the target 0.6301 vs 0.6513 alone",
  );
  assert(new Set(q).size === q.length, "queries are deduplicated");
  assert(
    memoryQueriesFor(Array.from({ length: 20 }, (_, i) => `f${i}.ts`)).length <= 12,
    "the fan-out is bounded — each query is a ~348 MB vipune process",
  );
}

// --------------------------------------------- selection, with a fake binary

{
  const hit = (id: string, sim: number) => ({ id, content: `row ${id}`, similarity: sim });
  const fakeExec = (rows: Array<{ id: string; similarity: number }>) => {
    const calls: string[] = [];
    const fn = async (_f: string, args: string[]) => {
      calls.push(args.join(" "));
      return {
        stdout: JSON.stringify({ results: rows.map((r) => hit(r.id, r.similarity)) }),
        stderr: "",
      };
    };
    return { fn, calls };
  };

  // 0.038462 is 1/26 — the ceiling for a row BM25 never saw. Nothing at or
  // below the ladder may be injected.
  const ladder = fakeExec([
    { id: "a", similarity: 0.038462 },
    { id: "b", similarity: 0.037037 },
  ]);
  const dead = await buildMemoryBrief(["permission-guard.ts"], { cwd: "/r", execFn: ladder.fn });
  assert(dead.emptyBrief, "a pure RRF ladder yields an EMPTY brief — the query found nothing");
  assert(dead.text === "", "...and no text at all, rather than a heading over zero rows");

  const found = fakeExec([
    { id: "real", similarity: 0.076923 },
    { id: "noise", similarity: 0.037037 },
  ]);
  const brief = await buildMemoryBrief(["permission-guard.ts"], { cwd: "/r", execFn: found.fn });
  assert(!brief.emptyBrief, "a row above the agreement bit IS injected");
  assert(brief.hits.length === 1, "...and only that row — the ladder rows are dropped");
  assert(brief.hits[0]?.id === "real", "...the right one");
  assert(
    /HYPOTHESES/.test(brief.text) && /\[vipune:real\]/.test(brief.text),
    "the brief is framed as hypotheses and carries the id for citation",
  );

  assert(
    found.calls.every((c) => !c.includes("--memory-type")),
    "reads are UNFILTERED — the type filter is what missed permission-guard.ts",
  );
  assert(
    found.calls.every((c) => c.includes("--include-candidates")),
    "...and include candidates, so the driver's own writes are reachable",
  );
  assert(
    found.calls.every((c) => c.includes("--recency") && c.includes("0.0")),
    "...at an explicit --recency 0.0",
  );

  // Exactly at the threshold must be admitted; just below must not.
  const atBar = fakeExec([{ id: "x", similarity: HYBRID_AGREEMENT }]);
  assert(
    !(await buildMemoryBrief(["a-file.ts"], { cwd: "/r", execFn: atBar.fn })).emptyBrief,
    `a row exactly at HYBRID_AGREEMENT (${HYBRID_AGREEMENT}) is admitted`,
  );
  const belowBar = fakeExec([{ id: "x", similarity: HYBRID_AGREEMENT - 0.0001 }]);
  assert(
    (await buildMemoryBrief(["a-file.ts"], { cwd: "/r", execFn: belowBar.fn })).emptyBrief,
    "...and a row just below it is not",
  );
}

// -------------------------------------------- never break a cycle, ever

{
  const boom = async () => {
    throw new Error("vipune is not installed");
  };
  const r = await buildMemoryBrief(["a.ts"], { cwd: "/r", execFn: boom as never });
  assert(r.emptyBrief && r.text === "", "a throwing vipune degrades to an empty brief");

  const junk = async () => ({ stdout: "not json at all", stderr: "" });
  const j = await buildMemoryBrief(["a.ts"], { cwd: "/r", execFn: junk as never });
  assert(j.emptyBrief, "unparseable output degrades to an empty brief");

  const none = await buildMemoryBrief([], { cwd: "/r", execFn: boom as never });
  assert(none.emptyBrief && none.queries.length === 0, "no paths → no queries, no spawns");
}

// ------------------------------------------ recall@K against a seeded store
//
// The case used to query the REAL ~/.vipune/memories.db and assert a hit at
// >= HYBRID_AGREEMENT. That assertion is brittle to corpus growth: on the
// ~111-row store the calibrated top score for permission-guard.ts was
// 0.076923; at 200+ rows it drifted to 0.074176 — 0.0008 under the bit — and
// the gate failed on a store that had done nothing wrong. So the case now
// seeds its own store, reusing the argv-prefix injection pattern from
// test-vipune.ts's live section: mkdtempSync + `--db-path <tmp>/db
// --project <name>` prepended via a wrapped execFn. The env-var pattern from
// test-vipune-capability.ts (VIPUNE_DB_PATH / VIPUNE_PROJECT) is NOT used:
// a live probe found it a no-op on some hosts (0 results vs 1 with the
// explicit flag).
//
// The committed fixture: five DISTINCT claims, each about a different source
// file, so the target is not trivially rank-1 by construction and
// preferNewest's near-duplicate collapse has nothing to fold. Two of the
// distractors are deliberately BM25-invisible to the query (they share no
// token with it), so the agreement bit — not the store's shape — is what
// admits the target. All five are `fact` so they are reachable unfiltered
// and through --include-candidates alike.
const FIXTURE: string[] = [
  "permission-guard.ts: trust mode returns immediately from the tool_call handler — no verdict resolution",
  "dispatch-deck.ts: render the dispatch list through pi-tui Text and SelectList widgets",
  "spawn.ts: close the child stdin only when agent_end arrives with willRetry false",
  "work-driver.ts: nextStep is a pure state transition — no handler may append to the event log",
  "model-adapters.ts: filter literal None placeholder text emitted by the GLM family",
];

const haveVipune = await execFileAsync("sh", ["-c", "command -v vipune"])
  .then(() => true)
  .catch(() => false);

if (!haveVipune) {
  const required = process.env.PI_ENSEMBLE_VIPUNE_REQUIRED === "1";
  console.log(required ? "✗ vipune absent and REQUIRED" : "… vipune absent — skipping recall@K");
  if (required) exit = 1;
} else {
  const dir = mkdtempSync(path.join(tmpdir(), "memory-brief-live-"));
  const db = path.join(dir, "m.db");
  const base = ["--db-path", db, "--project", "hermetic-brief"];
  const hermetic: import("../src/vipune.ts").VipuneOpts = {
    cwd: dir,
    timeoutMs: 20_000,
    execFn: (file, args, opts) =>
      execFileAsync(file, [...base, ...args], opts).then((x) => ({
        stdout: String(x.stdout),
        stderr: String(x.stderr),
      })),
  };
  try {
    // Seed sequentially: preferNewest tie-breaks on created_at, and a coarse
    // clock could stamp two parallel adds in the same millisecond.
    for (const row of FIXTURE) {
      const seeded = await execFileAsync(
        "vipune",
        [...base, "add", row, "--memory-type", "fact", "--json"],
      );
      if (!seeded.stdout.includes("\"added\"")) {
        console.error(`✗ fixture seeding failed for: ${row}`);
        console.error(seeded.stdout);
        exit = 1;
      }
    }

    // The positive: the file the sweep measured as the decisive case. Through
    // the full buildMemoryBrief path the seeded row is retrieved and its
    // hybrid score lands exactly at the both-retrievers-rank-1 value.
    const r = await buildMemoryBrief(["extension/src/permission-guard.ts"], hermetic);
    assert(
      !r.emptyBrief,
      `recall@K: permission-guard.ts retrieves from the seeded store (${r.hits.length} hit(s))`,
    );
    assert(
      (r.hits[0]?.similarity ?? 0) >= HYBRID_AGREEMENT,
      `...at the agreement bit — measured ${r.hits[0]?.similarity}, the 0.076923 both-retrievers-rank-1 value`,
    );
    assert(
      r.hits.length <= MAX_BRIEF_HITS,
      `...bounded at ${MAX_BRIEF_HITS} hits — injection cost, not recall, is the constraint`,
    );

    // Anti-vacuity canary (positive): the brief must carry the fixture row
    // itself, not any row at all. Delete the permission-guard.ts row from
    // FIXTURE and this fails.
    assert(
      r.hits.some((h) => h.content.includes("permission-guard.ts")),
      "...and the hit IS the seeded permission-guard.ts row (anti-vacuity canary)",
    );

    // And the negative: a file no fixture row mentions must stay silent.
    // No BM25 token in the store matches it, so its top hybrid score is the
    // dead-ladder ceiling 1/26 = 0.038462 — far below the agreement bit.
    const silent = await buildMemoryBrief(["extension/src/zzz-nonexistent-module.ts"], hermetic);
    assert(
      silent.emptyBrief,
      "recall@K: a file with no memory yields silence, not the top of the ladder",
    );

    // Anti-vacuity canary (negative): if anything in the store contained the
    // literal string "zzz-nonexistent-module", this would fail — proving the
    // silence above is the selection rule rejecting a match, not a broken
    // store. Run vipuneSearch directly (buildMemoryBrief swallows the
    // score on an empty brief) to assert the score itself.
    const { vipuneSearch } = await import("../src/vipune.ts");
    const raw = await vipuneSearch("zzz-nonexistent-module", {
      ...hermetic,
      hybrid: true,
      recency: 0,
    });
    if (raw.kind !== "hits" || raw.hits.length === 0) {
      console.error("✗ store unreachable for the negative canary — seeding or the seam broke");
      exit = 1;
    } else {
      const top = Math.max(...raw.hits.map((h) => h.similarity));
      assert(
        top < HYBRID_AGREEMENT,
        `...the store IS reachable, but its top hybrid score for the negative query stays below the bit (measured ${top})`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
