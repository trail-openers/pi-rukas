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
import { findingsStateDir } from "../src/review-state-path.ts";
import { decide } from "./lib/review-findings-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
// ── store, in a real temp clone ─────────────────────────────────────────────
// The pure identity half (anchor / titleClass / Jaccard / snippetHash / pickMatch)
// moved to test-review-findings-identity.ts with the fixture source it cites.
import { SRC } from "./test-review-findings-identity.ts";

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
// #1764 — this fixture runs with NO ledger override, so the store resolves to
// the real state-dir root. Pin `PI_ENSEMBLE_REVIEW_STATE`-free isolation by
// pointing `PI_AGENT_DIR` at a temp dir: the store lands there, never in the
// operator's `~/.pi/agent`.
const savedAgentDir = process.env.PI_AGENT_DIR;
const agentDir = mkdtempSync(path.join(os.tmpdir(), "findings-store-agent-"));
process.env.PI_AGENT_DIR = agentDir;
try {
  const c1 = commit(SRC.join("\n"));
  // #1764 phase 1 — the store resolves through the state-dir resolver, which
  // is the same one the store's own `locate` uses. With no
  // `PI_ENSEMBLE_REVIEW_LEDGER_FILE` in the environment this is the REAL
  // location: under `$PI_AGENT_DIR/review-state/<key>/<token>/`, outside the
  // clone. The test pins its own agent dir so a fixture never writes the
  // operator's.
  const loc = await findingsStateDir(execp, dir);
  assert(
    loc !== undefined && existsSync(path.dirname(loc.ledger)),
    "store: the clone has a git common dir",
  );

  const first = await decide({
    cwd: dir,
    branch: "feat/x",
    headSha: c1,
    findings: [finding("Division by zero possible", 4)],
    review: "full",
  });
  const findingsFile = loc?.file as string;
  assert(
    existsSync(findingsFile),
    "store: the findings file is written in the clone's state dir",
  );
  assert(
    !findingsFile.startsWith(dir),
    "store: the findings file is NOT inside the clone (#1764)",
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
  rmSync(agentDir, { recursive: true, force: true });
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
  (await import("../src/review-state-path.ts")).resetFindingsStateCache();
}

process.exit(exit);
