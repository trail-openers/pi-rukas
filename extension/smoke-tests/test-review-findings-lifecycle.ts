#!/usr/bin/env bun
/**
 * #1125 — the four rules the findings memory gained, each against a real git
 * repo with the round driven directly through `recordFindingRunOutcome`:
 *
 *   A. delta-aware resolution (decision 5): a delta round resolves a row only
 *      when the cited line is INSIDE the delta's changed ranges. A line the
 *      round never saw keeps its row open; a line the round rewrote resolves.
 *   B. accepted-row eviction: a row whose path is gone at head is evicted on a
 *      full round (path-gone) rather than kept alive forever by its acceptance.
 *   C. disclosure: an acceptance that lapses, a malformed row, and an
 *      unreadable findings file each surface to the operator through
 *      `setAside` / `memoryNote` — a round that ran without memory never
 *      reports "no memory" as if it had consulted it.
 *   D. a carried row re-reports with a non-empty description: what the lens
 *      said when it found the issue rides on the row.
 *
 * Offline: no Pi child is spawned; the ledger is redirected to a temp dir.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Finding } from "../src/lens-review-types.ts";
import { setupReviewFixture } from "./lib/review-findings-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { FINDINGS_FILE, acceptFinding, readBranchRows, recordFindingRunOutcome } = await import(
  "../src/review-findings-store.ts"
);

const SRC = [
  "// header", // 1
  "export function alpha(x: number) {", // 2
  "  const a = x + 1;", // 3
  "  return a * 2;", // 4
  "}", // 5
];

function finding(title: string, line: number, over: Partial<Finding> = {}): Finding {
  return {
    lens: "security",
    severity: "MEDIUM",
    path: "src/a.ts",
    line,
    title,
    description: `the finding text for ${title}`,
    ...over,
  } as Finding;
}

function deltaDiff(hunk: string): string {
  return `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${hunk}\n`;
}

const fixture = setupReviewFixture({
  prefix: "findings-lifecycle",
  branch: "feat/x",
  files: { "src/a.ts": `${SRC.join("\n")}\n`, "src/gone.ts": "export const g = 1;\n" },
  report: () => [],
});
const repo = fixture.repo;
const sh = fixture.sh;

try {
  const headOf = () => sh("git rev-parse HEAD");

  // ── A. delta-aware resolution (decision 5) ────────────────────────────────
  // Two heads: `base` (the original file) and `d1`, where line 3 was rewritten.
  // Each scenario creates its rows on its OWN branch at the head BEFORE the
  // delta round that judges them — a row's cited line is read from the head its
  // round reviews, so a row created at an older head would simply be judged
  // against code that moved.
  const base = headOf();
  writeFileSync(
    path.join(repo, "src", "a.ts"),
    `${SRC.join("\n")}\n`.replace("  const a = x + 1;", "  const b = x + 2;"),
  );
  sh("git add -A");
  sh("git commit -qm delta1");
  const d1 = headOf();
  // The delta for every A round below: only line 1 changed, so line 3 is
  // outside the round's field of view and line 1 is inside it.
  const headerDelta = deltaDiff("@@ -1,1 +1,1 @@\n-// header\n+// header two");

  /** One branch with `n` open rows created at `sha`, each citing its own line. */
  async function seed(branch: string, sha: string, lines: number[]): Promise<void> {
    const r = await recordFindingRunOutcome({
      cwd: repo,
      branch,
      headSha: sha,
      findings: lines.map((n, i) => finding(`Finding ${i + 1} at line ${n}`, n)),
      review: "full",
    });
    assert(r.ok === true, `seed: ${branch} records its rows`);
  }

  // A1 — a row whose cited line the delta did NOT review stays open, even though
  // the round resolved nothing: the round cannot clear a finding on code it
  // never saw. The header line the round DID review resolves when unreported.
  await seed("feat-outside", d1, [3]);
  const roundOutside = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat-outside",
    headSha: d1,
    findings: [],
    review: "delta",
    deltaDiff: headerDelta,
  });
  assert(roundOutside.ok === true, "A1: the outside-ranges delta round records");
  assert(
    (roundOutside.ok && roundOutside.resolved.length === 0) || false,
    "A1: a delta resolves nothing outside its own changed ranges",
  );
  assert(
    (roundOutside.ok && roundOutside.carried.length === 1) || false,
    `A1: the unreviewed row is carried into the verdict, not dropped (${roundOutside.ok && roundOutside.carried.length})`,
  );
  assert(
    (await readBranchRows(repo, "feat-outside")).every((r) => r.status === "open"),
    "A1: a delta cannot resolve a row on a line it never reviewed",
  );

  // A2 — the control that makes A1 mean something: at the SAME head, with the
  // SAME single open row citing line 3, and that line genuinely changed since
  // the row was seeded, a FULL round resolves it. The only difference from A1 is
  // that this round reviewed the whole branch instead of a delta — so A1's carry
  // is the delta restriction doing work, not an inert rule.
  const pre = headOf();
  await seed("feat-full", pre, [3]);
  writeFileSync(
    path.join(repo, "src", "a.ts"),
    `${SRC.join("\n")}\n`.replace("  const a = x + 1;", "  const ok = Math.max(1, x);"),
  );
  sh("git add -A");
  sh("git commit -qm line-three-fixed");
  const d2 = headOf();
  const roundFull = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat-full",
    headSha: d2,
    findings: [],
    review: "full",
  });
  assert(roundFull.ok === true, "A2: the full round records");
  const fullRow = (await readBranchRows(repo, "feat-full"))[0];
  assert(
    fullRow?.status === "resolved" && fullRow.resolvedReason === "code-gone",
    `A2: a full round resolves the row whose cited line changed (${fullRow?.status}/${fullRow?.resolvedReason})`,
  );

  // A3 — a delta round with NO diff at all REFUSES: without changed ranges
  // nothing separates a line the round reviewed from one it never saw, so it has
  // no coverage evidence on any row and must not record a round whose silence
  // would read as coverage (#1125 decision 5). The refusal is a `{ok:false}`
  // with a reason, not a recorded round that resolves nothing.
  const roundNoRanges = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat-inside",
    headSha: d1,
    findings: [],
    review: "delta",
  });
  assert(
    roundNoRanges.ok === false &&
      (roundNoRanges.ok === false
        ? roundNoRanges.reason.includes("a delta round supplied no changed line ranges")
        : false),
    `A3: a delta round with no diff refuses with the contract reason (${JSON.stringify(roundNoRanges)})`,
  );
  // The refusal wrote nothing: a later round with a real diff still sees the
  // row the refused round did not resolve.
  await seed("feat-inside", d1, [3]);
  const roundAfterRefusal = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat-inside",
    headSha: d1,
    findings: [],
    review: "delta",
    deltaDiff: headerDelta,
  });
  assert(
    roundAfterRefusal.ok === true &&
      roundAfterRefusal.resolved.length === 0 &&
      roundAfterRefusal.carried.length === 1,
    `A3: the refused round left the store untouched — the row still stands (${JSON.stringify(roundAfterRefusal.ok ? { resolved: roundAfterRefusal.resolved.length, carried: roundAfterRefusal.carried.length } : roundAfterRefusal)})`,
  );

  // A4 — #1677: the delta's changed ranges cover the cited line, and that line's
  // code changed since the row was seeded. The delta reviewed the line, so the
  // row resolves (code-gone) and is not carried into the verdict.
  const pre4 = headOf();
  await seed("feat-delta-fixed", pre4, [3]);
  const lineThree = (text: string) => `${SRC.map((l, i) => (i === 2 ? text : l)).join("\n")}\n`;
  writeFileSync(path.join(repo, "src", "a.ts"), lineThree("  const c = x + 3;"));
  sh("git add -A");
  sh("git commit -qm line-three-changed-again");
  const d4 = headOf();
  const roundA4 = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat-delta-fixed",
    headSha: d4,
    findings: [],
    review: "delta",
    deltaDiff: deltaDiff("@@ -3 +3 @@\n-  const ok = Math.max(1, x);\n+  const c = x + 3;"),
  });
  assert(
    roundA4.ok === true &&
      roundA4.resolved.length === 1 &&
      roundA4.resolved[0]?.reason === "code-gone" &&
      roundA4.carried.length === 0,
    `A4: a delta that changed the cited line resolves it (code-gone) and does not carry it (${JSON.stringify(roundA4.ok ? { resolved: roundA4.resolved, carried: roundA4.carried.length } : roundA4)})`,
  );

  // A5 — the delta covers the cited line but its code still matches (the line was
  // touched without a content change): the row is carried and still stands.
  sh("git commit -q --allow-empty -m touched-without-change");
  const d5 = headOf();
  await seed("feat-still-matching", d4, [3]);
  const roundA5 = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat-still-matching",
    headSha: d5,
    findings: [],
    review: "delta",
    deltaDiff: deltaDiff("@@ -3 +3 @@\n-  const c = x + 3;\n+  const c = x + 3;"),
  });
  assert(
    roundA5.ok === true && roundA5.resolved.length === 0 && roundA5.carried.length === 1,
    "A5: a still-matching row on a delta-covered line is carried, not resolved",
  );

  // A6 — CRITICAL is never resolved by a code change, delta or not (#1677 keeps it).
  writeFileSync(path.join(repo, "src", "a.ts"), lineThree("  const e = x + 5;"));
  sh("git add -A");
  sh("git commit -qm line-three-changed-critical");
  const d6 = headOf();
  await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat-critical-delta",
    headSha: d5,
    findings: [{ ...finding("Critical at line 3", 3), severity: "CRITICAL" }],
    review: "full",
  });
  const roundA6 = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat-critical-delta",
    headSha: d6,
    findings: [],
    review: "delta",
    deltaDiff: deltaDiff("@@ -3 +3 @@\n-  const c = x + 3;\n+  const e = x + 5;"),
  });
  assert(
    roundA6.ok === true && roundA6.resolved.length === 0 && roundA6.carried.length === 1,
    "A6: a CRITICAL row whose cited line changed on a delta is carried, not resolved",
  );

  // ── B. accepted-row eviction on a gone path ────────────────────────────────
  await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat/gone",
    headSha: base,
    findings: [finding("Dead constant", 1, { path: "src/gone.ts" })],
    review: "full",
  });
  const goneRows = await readBranchRows(repo, "feat/gone");
  const acc = await acceptFinding(repo, "feat/gone", goneRows[0]?.id ?? "", {
    by: "op@example.com",
    reason: "the file is being removed in the next release anyway",
  });
  assert(acc.ok === true, "B: the operator accepts the row on the file that will vanish");
  sh("git rm -q src/gone.ts");
  sh("git commit -qm remove-gone");
  const g1 = headOf();
  const goneRound = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat/gone",
    headSha: g1,
    findings: [],
    review: "full",
  });
  assert(goneRound.ok === true, "B: the round after the file was deleted records");
  const goneAfter = (await readBranchRows(repo, "feat/gone"))[0];
  assert(
    goneAfter?.status === "resolved" && goneAfter.resolvedReason === "path-gone",
    `B: the accepted row on a gone path is EVICTED (path-gone), not kept by its acceptance (${goneAfter?.status}/${goneAfter?.resolvedReason})`,
  );
  assert(
    goneAfter?.acceptance === undefined,
    "B: the evicted row sheds the acceptance that would have kept it alive",
  );
  // On a delta round the same row is carried, not resolved: the delta never saw
  // the deletion (decision 5 keeps the asymmetry honest).
  await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat/gone-delta",
    headSha: base,
    findings: [finding("Dead constant", 1, { path: "src/gone.ts" })],
    review: "full",
  });
  const gdRows = await readBranchRows(repo, "feat/gone-delta");
  await acceptFinding(repo, "feat/gone-delta", gdRows[0]?.id ?? "", {
    by: "op@example.com",
    reason: "the file is being removed in the next release anyway",
  });
  const gdRound = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat/gone-delta",
    headSha: g1,
    findings: [],
    review: "delta",
    deltaDiff:
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-// header\n+// header 2\n",
  });
  assert(
    (await readBranchRows(repo, "feat/gone-delta"))[0]?.status === "accepted",
    `B: the same row survives a delta round that never saw the deletion (${(gdRound.ok && "recorded") ?? "unrecorded"})`,
  );

  // ── C. disclosure: lapse, malformed row, unreadable file ───────────────────
  // C1 — a lapsed acceptance is named.
  await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat/lapse",
    headSha: base,
    findings: [finding("Shadowed loop var", 3)],
    review: "full",
  });
  const lapRows = await readBranchRows(repo, "feat/lapse");
  await acceptFinding(repo, "feat/lapse", lapRows[0]?.id ?? "", {
    by: "op@example.com",
    reason: "intentional shadowing, matches the surrounding style",
  });
  writeFileSync(
    path.join(repo, "src", "a.ts"),
    "// header\nexport function alpha(x: number) {\n  const a = x + 1;\n  const a2 = x + 2;\n  return a * 2;\n}\n",
  );
  sh("git add -A");
  sh("git commit -qm edit-cited-line");
  const l1 = headOf();
  const lapseRound = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat/lapse",
    headSha: l1,
    findings: [finding("Shadowed loop var", 4)],
    review: "full",
  });
  assert(lapseRound.ok === true, "C1: the round after the cited line changed records");
  assert(
    lapseRound.ok === true &&
      (lapseRound.setAside ?? []).some((s) => s.title === "Shadowed loop var" && s.wasAcceptance),
    "C1: the lapsed acceptance is disclosed via setAside (wasAcceptance)",
  );

  // C2 — a malformed row on the branch is set aside AND disclosed. The store
  // refuses to act on a row it cannot validate: it is copied to the side and
  // named, never silently trusted as suppression or as an open row.
  const file = path.join(fixture.ledgerDir, FINDINGS_FILE);
  const badRow = {
    id: "deadbeef",
    branch: "feat/bad",
    path: 42,
    anchor: "file",
    titleClass: "x",
    title: "Unreadable shape",
    severity: "HIGH",
    lens: "security",
    snippetHash: "abcdef0123456789",
    firstSeen: 1,
    lastSeen: 1,
  };
  writeFileSync(file, `${JSON.stringify({ rows: [badRow] }, null, 2)}\n`, "utf8");
  const badRound = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat/bad",
    headSha: base,
    findings: [],
    review: "full",
  });
  assert(
    badRound.ok === true && (badRound.setAside ?? []).length === 1,
    `C2: the malformed row is set aside and disclosed (${badRound.ok && (badRound.setAside ?? []).length})`,
  );
  assert(
    badRound.ok === true && badRound.setAside?.[0]?.problem !== undefined,
    `C2: the notice names the validation failure (${badRound.ok && JSON.stringify(badRound.setAside?.[0]?.problem)})`,
  );
  assert(
    badRound.ok === true && badRound.setAside?.[0]?.wasAcceptance === false,
    "C2: the notice says whether the row held an acceptance",
  );
  assert(
    !readFileSync(file, "utf8").includes("deadbeef"),
    "C2: the row is gone from the store — the store never trusts it",
  );
  const copies = readdirSync(fixture.ledgerDir).filter((f) =>
    f.startsWith(`${FINDINGS_FILE}.corrupt-`),
  );
  assert(
    copies.length === 1 &&
      readFileSync(path.join(fixture.ledgerDir, copies[0] ?? ""), "utf8").includes("deadbeef"),
    "C2: the set-aside copy keeps the row on disk where the operator can still read it",
  );

  // C3 — a findings file that exists but cannot be read FAILS the round. A round
  // recorded on "no memory" would resolve the open rows that file may still
  // hold, so "unreadable" is never allowed to look like "empty" (#1125).
  const unreadable = setupReviewFixture({
    prefix: "findings-unreadable",
    files: { "src/a.ts": `${SRC.join("\n")}\n` },
    report: () => [],
  });
  try {
    const uFile = path.join(unreadable.ledgerDir, FINDINGS_FILE);
    // Not valid JSON: the round cannot get a row list out of it, and the store
    // must not proceed as though the branch had no rows.
    writeFileSync(uFile, "{ not json at all", "utf8");
    const uRound = await recordFindingRunOutcome({
      cwd: unreadable.repo,
      branch: "feat/unreadable",
      headSha: unreadable.sh("git rev-parse HEAD"),
      findings: [finding("Something worth reporting", 3)],
      review: "full",
    });
    assert(
      uRound.ok === false &&
        (uRound.ok === false ? uRound.reason.includes("could not be read") : false),
      `C3: an unreadable findings file fails the round with a named reason (${JSON.stringify(uRound)})`,
    );
    assert(
      readFileSync(uFile, "utf8") === "{ not json at all",
      "C3: the refused round leaves the unreadable file untouched",
    );
  } finally {
    unreadable.cleanup();
  }

  // ── D. a carried row re-reports with a non-empty description ───────────────
  // A row carried in a later round is rendered from the row alone, so the prose
  // the lens gave when it found the issue has to ride on the row (#1130).
  const dHead = headOf();
  const seeded = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat/desc",
    headSha: dHead,
    findings: [
      {
        ...finding("Missing await on the fetch", 3),
        description: "the promise returned on this line is never awaited",
        suggestion: "await the call, or void it explicitly to say so",
      } as Finding,
    ],
    review: "full",
  });
  assert(
    seeded.ok === true,
    `D: the round that records the finding works (${JSON.stringify(seeded)})`,
  );
  assert(
    (await readBranchRows(repo, "feat/desc"))[0]?.description ===
      "the promise returned on this line is never awaited",
    "D: the row stores the description it was reported with",
  );
  const carryRound = await recordFindingRunOutcome({
    cwd: repo,
    branch: "feat/desc",
    headSha: dHead,
    findings: [],
    review: "incomplete",
  });
  const carried =
    (carryRound.ok && carryRound.carried.find((c) => c.title === "Missing await on the fetch")) ||
    undefined;
  assert(carried !== undefined, "D: the omitted open finding is carried forward");
  assert(
    (carried?.description ?? "").length > 0,
    `D: the carried finding re-reports with the stored description, never empty (${JSON.stringify(carried?.description)})`,
  );
  assert(
    carried?.suggestion === "await the call, or void it explicitly to say so",
    "D: the stored suggestion rides along too",
  );
  assert(carried?.carried === true, "D: a carried row is marked carried in the round's report");
} finally {
  fixture.cleanup();
}

process.exit(exit);
