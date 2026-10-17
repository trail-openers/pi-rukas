#!/usr/bin/env bun
/**
 * #1105 — the per-branch review-findings memory: identity (anchor, titleClass,
 * Jaccard, snippetHash, no-line findings), the store round trip in a real temp
 * git clone (file beside the ledger, 8-hex ids, the 200-row cap, suppression
 * of unchanged and accepted findings, CRITICAL never dropped, a lapsed
 * acceptance, concurrent writers). The prior-findings DATA block and the
 * delta's changed-line ranges live in test-review-findings-store-block.ts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { partitionDecisions } from "../src/lens-residuals.ts";
import type { Finding } from "../src/lens-review-types.ts";
import {
  type FindingIdentity,
  type MatchableRow,
  anchorAt,
  identityOf,
  jaccard,
  pickMatch,
  snippetHashAt,
  titleClassOf,
  titleTokens,
} from "../src/review-findings-match.ts";
import { acceptFinding as acceptFinding } from "../src/review-findings-store.ts";
import { readBranchRows, recordFindingRunOutcome } from "../src/review-findings-store.ts";
import { ledgerPathFor } from "../src/review-ledger-path.ts";
import { decide } from "./lib/review-findings-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── pure identity ───────────────────────────────────────────────────────────

const SRC = [
  "// header", // 1
  "export function alpha(x: number) {", // 2
  "  const a = x + 1;", // 3
  "  return a * 2;", // 4
  "}", // 5
  "", // 6
  "export class Beta {", // 7
  "  run() {", // 8
  "    return 1;", // 9
  "  }", // 10
  "}", // 11
];

assert(
  anchorAt(SRC, 4) === "alpha",
  "anchor: nearest declaration above the cited line is the enclosing function",
);
assert(anchorAt(SRC, 9) === "run", "anchor: a method declaration is found (run, not the class)");
assert(anchorAt(SRC, 1) === "file", "anchor: no declaration at or above the line → file");
assert(anchorAt(SRC, undefined) === "file", "anchor: no line → file");
const shifted = ["x", "y", ...SRC];
assert(anchorAt(shifted, 6) === "alpha", "anchor: a line shift keeps the same anchor");
assert(
  snippetHashAt(SRC, 4) === snippetHashAt(shifted, 6),
  "snippetHash: a positional ±2 window moves with its code, so a pure shift keeps the hash",
);
assert(
  snippetHashAt(SRC, 4) ===
    snippetHashAt(
      SRC.map((l) => l.replace(/ +/g, "  ")),
      4,
    ),
  "snippetHash: whitespace-normalised (runs of spaces collapse)",
);
assert(
  snippetHashAt(SRC, 4) !== snippetHashAt(SRC, 9),
  "snippetHash: different code, different hash",
);

assert(
  titleClassOf("The default timeout is not set") === titleClassOf("Timeout default set"),
  "titleClass: stopwords removed and tokens sorted, so word order and filler do not matter",
);
assert(titleTokens("the a of").length === 0, "titleTokens: stopword-only title yields no tokens");
assert(jaccard(["a", "b", "c"], ["a", "b", "d"]) === 0.5, "jaccard: 2 shared of 4 union = 0.5");
assert(jaccard([], ["a"]) === 0, "jaccard: an empty side is 0");

const mk = (title: string, line: number | undefined, lines: string[] = SRC) =>
  identityOf({ path: "src/a.ts", line, title }, lines);
const rowOf = (
  id: FindingIdentity,
  extra: Partial<MatchableRow> = {},
): MatchableRow & { title: string } => ({
  id: "deadbeef",
  path: id.path,
  anchor: id.anchor,
  titleClass: id.titleClass,
  title: id.title,
  snippetHash: id.snippetHash,
  lastSeen: 1,
  ...extra,
});

const base = mk("Division by zero possible", 4);
assert(
  pickMatch(mk("Division by zero possible", 6, shifted), [rowOf(base)]) !== undefined,
  "match: identical title after a line shift matches (same anchor, same titleClass)",
);
assert(
  pickMatch(mk("possible division by zero!", 4), [rowOf(base)]) !== undefined,
  "match: reworded title with the same tokens matches on titleClass",
);
assert(
  pickMatch(mk("Division by zero may occur", 4), [rowOf(base)]) === undefined,
  "match: a rewording below Jaccard 0.6 on the same snippet is a new finding, not the old row",
);
assert(
  pickMatch(mk("Unrelated logging issue", 3), [rowOf(base)]) === undefined,
  "match: an unrelated title on the same anchor and a different snippet does not match",
);
const otherAnchor = mk("Division by zero possible", 9);
assert(
  pickMatch(otherAnchor, [rowOf(base)]) === undefined,
  "match: a different anchor never matches",
);
const noLine = mk("Missing null check", undefined);
const noLine2 = mk("Hardcoded retry budget", undefined);
assert(noLine.anchor === "file" && !noLine.hasLine, "no-line finding: anchor file, hasLine false");
assert(
  pickMatch(noLine2, [rowOf(noLine)]) === undefined,
  "no-line finding: two different no-line findings in one file do NOT match on the empty snippet",
);
assert(
  pickMatch(mk("Missing null check", undefined), [rowOf(noLine)]) !== undefined,
  "no-line finding: the same title matches on titleClass",
);
const snippetOnly = mk("Completely different words here", 4);
assert(
  pickMatch(snippetOnly, [rowOf(base, { title: "zzz qqq", titleClass: "qqq zzz" })]) === undefined,
  "match: an equal snippetHash alone does not match when titles differ (a new row)",
);

const older = rowOf(base, { id: "00000001", lastSeen: 10 });
const newer = rowOf(base, { id: "00000002", lastSeen: 20, snippetHash: "other" });
assert(
  pickMatch(base, [older, newer])?.id === "00000001",
  "pick: an equal-snippet row beats a more recent row with a different snippet",
);
assert(
  pickMatch(mk("Division by zero possible", 4), [older, { ...older, id: "00000003", lastSeen: 30 }])
    ?.id === "00000003",
  "pick: among equal candidates the most recently seen wins",
);

// ── store, in a real temp clone ─────────────────────────────────────────────

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeRepo(): { dir: string; commit: (content: string) => string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "findings-store-"));
  git(dir, "init", "-q", "-b", "feat/x");
  git(dir, "config", "user.email", "dev@example.com");
  git(dir, "config", "user.name", "dev");
  mkdirSync(path.join(dir, "src"));
  const commit = (content: string) => {
    writeFileSync(path.join(dir, "src", "a.ts"), content);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "c");
    return git(dir, "rev-parse", "HEAD");
  };
  return { dir, commit };
}

const finding = (
  title: string,
  line: number,
  severity: Finding["severity"] = "MEDIUM",
): Finding => ({
  lens: "SIMPLICITY",
  severity,
  path: "src/a.ts",
  line,
  title,
});

const { dir, commit } = makeRepo();
try {
  const c1 = commit(SRC.join("\n"));
  const ledger = await ledgerPathFor(execp, dir);
  assert(
    ledger !== undefined && existsSync(path.dirname(ledger)),
    "store: the clone has a git common dir",
  );

  const first = await decide({
    cwd: dir,
    branch: "feat/x",
    headSha: c1,
    findings: [finding("Division by zero possible", 4)],
    review: "full",
  });
  const findingsFile = path.join(path.dirname(ledger as string), "review-findings.json");
  assert(
    existsSync(findingsFile),
    "store: review-findings.json is written beside review-ledger.json",
  );
  const rows1 = await readBranchRows(dir, "feat/x");
  assert(
    rows1.length === 1 && /^[0-9a-f]{8}$/.test(rows1[0]?.id ?? ""),
    "store: one row with an 8-hex id",
  );
  assert(first?.[0]?.action === "new", "store: a first finding is new");
  const rowId = first?.[0]?.rowId ?? "";

  // A delta round after lines were inserted above the function: the finding
  // sits on untouched code, so it is suppressed and keeps its row.
  const c2 = commit(["// new 1", "// new 2", ...SRC].join("\n"));
  const deltaDiff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -0,0 +1,2 @@",
    "+// new 1",
    "+// new 2",
  ].join("\n");
  const delta = await decide({
    cwd: dir,
    branch: "feat/x",
    headSha: c2,
    findings: [finding("Division by zero possible", 6)],
    deltaDiff,
    review: "delta",
  });
  assert(
    delta?.[0]?.action === "suppressed-unchanged" && delta[0].rowId === rowId,
    "delta: a finding outside the changed lines, after a line shift, is suppressed-unchanged on the SAME row (same anchor)",
  );
  const { kept, suppressed } = partitionDecisions([finding("Division by zero possible", 6)], delta);
  assert(
    kept.length === 0 && suppressed[0]?.rowId === rowId && suppressed[0].reason.includes("outside"),
    "delta: the suppressed finding leaves the review and names its row and reason",
  );

  // Accept it by id (the operator path), then a later full round suppresses it.
  const accepted = await acceptFinding(dir, "feat/x", rowId, {
    by: "op@example.com",
    reason: "known, tracked in a later issue",
  });
  assert(accepted.ok, "accept: an open row can be accepted by id");
  const later = await decide({
    cwd: dir,
    branch: "feat/x",
    headSha: c2,
    findings: [finding("Division by zero possible", 6)],
    review: "full",
  });
  assert(
    later?.[0]?.action === "suppressed-accepted" && later[0].reason.includes("op@example.com"),
    "accepted: an accepted row with an unchanged snippet is suppressed-accepted and the reason names the operator",
  );

  // CRITICAL is never dropped, even when it matches an accepted row.
  const crit = await decide({
    cwd: dir,
    branch: "feat/x",
    headSha: c2,
    findings: [finding("Division by zero possible", 6, "CRITICAL")],
    review: "full",
  });
  assert(
    crit?.[0]?.action === "matched",
    "CRITICAL: never suppressed, even on an accepted unchanged row",
  );

  // Same snippet, different title on the accepted line: a different finding, so
  // it gets its own row and is reported, never suppressed by the acceptance.
  const otherTitle = await decide({
    cwd: dir,
    branch: "feat/x",
    headSha: c2,
    findings: [finding("Unchecked integer overflow", 6)],
    review: "full",
  });
  assert(
    otherTitle?.[0]?.action === "new",
    "accepted: a different title on the same accepted snippet is a new row, not suppressed",
  );

  // Changing the code the row cites lapses the acceptance.
  const c3 = commit(
    [
      "// new 1",
      "// new 2",
      "// new 3",
      ...SRC.slice(0, 2),
      "  const a = x + 9;",
      ...SRC.slice(3),
    ].join("\n"),
  );
  const lapsed = await decide({
    cwd: dir,
    branch: "feat/x",
    headSha: c3,
    findings: [finding("Division by zero possible", 7)],
    review: "full",
  });
  assert(
    lapsed?.[0]?.action === "matched",
    "accepted: a changed snippet lapses the acceptance and the finding is reported again",
  );
  const lapsedRow = (await readBranchRows(dir, "feat/x")).find((r) => r.id === rowId);
  assert(
    lapsedRow?.status === "open" && lapsedRow.acceptance === undefined,
    "accepted: the lapsed row is open with no acceptance",
  );

  // A complete full review resolves a row whose cited line was truncated away
  // (a changed line-bearing row is carried; see test-review-findings-resolve.ts).
  const c4 = commit("// header\n");
  await decide({ cwd: dir, branch: "feat/x", headSha: c4, findings: [], review: "full" });
  assert(
    (await readBranchRows(dir, "feat/x"))[0]?.status === "resolved",
    "resolve: an open row whose cited line is past the end of the file resolves",
  );
  const refused = await acceptFinding(dir, "feat/x", rowId, {
    by: "op",
    reason: "a resolved row cannot be accepted",
  });
  assert(!refused.ok, "accept: a resolved row is refused");
  assert(
    !(
      await acceptFinding(dir, "feat/x", "ffffffff", {
    by: "op",
    reason: "no such row exists here",
  })
    ).ok,
    "accept: an unknown row id is refused",
  );

  // Concurrent writers on one clone: every row survives (the ledger lock).
  const runs = await Promise.all(
    ["alpha one", "beta two", "gamma three", "delta four", "epsilon five"].map((t, i) =>
      decide({
        cwd: dir,
        branch: "feat/y",
        headSha: c3,
        findings: [
          finding(`Unique concurrent finding ${t} with words${i}`, [3, 4, 7, 9, 11][i] ?? 4),
        ],
        review: "incomplete",
      }),
    ),
  );
  assert(
    runs.every((r) => r?.[0]?.action === "new"),
    "concurrent: every writer recorded its finding",
  );
  assert(
    (await readBranchRows(dir, "feat/y")).length === 5,
    "concurrent: all five rows survive the race",
  );

  // No-line findings: an acceptance binds to the title, not to shared tokens.
  const nl = await decide({
    cwd: dir,
    branch: "feat/nl",
    headSha: c3,
    findings: [
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/a.ts",
        title: "Missing null check on token",
      },
    ],
    review: "full",
  });
  const nlId = nl?.[0]?.rowId ?? "";
  await acceptFinding(dir, "feat/nl", nlId, {
    by: "op@example.com",
    reason: "file-level gap, tracked elsewhere",
  });
  const sibling = await decide({
    cwd: dir,
    branch: "feat/nl",
    headSha: c3,
    findings: [
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/a.ts",
        title: "Missing null check on user",
      },
    ],
    review: "full",
  });
  assert(
    sibling?.[0]?.action === "new",
    "no-line: a different title sharing 0.6 of its tokens gets its own row, not the acceptance",
  );
  const sameTitle = await decide({
    cwd: dir,
    branch: "feat/nl",
    headSha: c3,
    findings: [
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/a.ts",
        title: "Missing null check on token",
      },
    ],
    review: "full",
  });
  assert(
    sameTitle?.[0]?.action === "suppressed-accepted",
    "no-line: the same title stays suppressed by its acceptance",
  );

  // A changed neighbour line changes the ±2 snippet window: a delta that touched
  // line 3 must not suppress the finding on line 4 as unchanged.
  const n1 = commit(SRC.join("\n"));
  await decide({
    cwd: dir,
    branch: "feat/nb",
    headSha: n1,
    findings: [finding("Division by zero possible", 4)],
    review: "full",
  });
  const n2 = commit(SRC.map((l, i) => (i === 2 ? "  const a = x + 9;" : l)).join("\n"));
  const neighbour = await decide({
    cwd: dir,
    branch: "feat/nb",
    headSha: n2,
    findings: [finding("Division by zero possible", 4)],
    deltaDiff: [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,1 +3,1 @@",
      "-  const a = x + 1;",
      "+  const a = x + 9;",
    ].join("\n"),
    review: "delta",
  });
  assert(
    neighbour?.[0]?.action === "matched",
    "delta: a changed neighbour line changes the snippet, so the finding is matched, not suppressed-unchanged",
  );

  // A corrupt findings file fails closed: no suppression, and it is not overwritten.
  writeFileSync(findingsFile, "{not json");
  const corruptRun = await decide({
    cwd: dir,
    branch: "feat/x",
    headSha: c3,
    findings: [finding("Division by zero possible", 6)],
    review: "full",
  });
  assert(corruptRun === undefined, "corrupt: an unparsable findings file records nothing");
  assert(
    readFileSync(findingsFile, "utf8") === "{not json",
    "corrupt: the unparsable file is left untouched, not overwritten",
  );
  writeFileSync(findingsFile, JSON.stringify({ rows: [] }));

  // A branch's rows never leak into another branch's view.
  assert(
    (await readBranchRows(dir, "feat/x")).every((r) => r.branch === "feat/x"),
    "store: rows are per branch",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(exit);
