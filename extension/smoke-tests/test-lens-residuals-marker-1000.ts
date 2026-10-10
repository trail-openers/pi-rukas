#!/usr/bin/env bun
/**
 * #1000 — the marker's FULL branch name (no segment stripped) and the
 * explicit-pr path, with a STUBBED forge (the execFn seam, no real gh/glab
 * call).
 *
 * Companion to test-lens-residuals-marker.ts (#973 — the post trigger and
 * marker shape). This file covers the #1000 cases:
 *   - a multi-segment branch (`feature/issue-1-x`) posts the FULL branch
 *     name (no segment stripped — the value is already bare) via the
 *     branch-lookup path;
 *   - the same assertion via the explicit-pr path;
 *   - poster↔guard consistency: the posted body equals the guard's
 *     `lensResidualsMarker` output for the same headRefName/patchId;
 *   - the explicit-pr path skips the branch lookup entirely;
 *   - an unsafe headRefName (containing `-->`) is NOT posted (fail closed).
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { postLensResidualDisclosure } from "../src/lens-review-residuals.ts";
import { lensResidualsMarker } from "../src/merge-guard-round-cap.ts";
import type { LensReviewSummary } from "../src/lens-review.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A minimal summary shape the post reads (verdict + findings). */
function summary(
  verdict: string,
  findings: Array<{ severity: string; path: string; line: number; title: string; lens: string }>,
): LensReviewSummary {
  return {
    verdict: verdict as never,
    totalFindings: findings.length,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    lenses: [],
    findings: findings as never,
  };
}

const FINDING = { severity: "MEDIUM", path: "src/a.ts", line: 10, title: "a finding", lens: "SIMPLICITY" };
const ISSUES = summary("ISSUES_FOUND", [FINDING]);

type Stub = {
  execFn: (cmd: string) => Promise<{ stdout: string }>;
  calls: string[];
  bodyFiles: string[];
};

/**
 * A stubbed exec for the post with a given headRefName: records every
 * command, returns canned stdout for the PR-number and PR-identity reads
 * (PR 12 for the branch; the marker's branch ALWAYS comes from the
 * identity read), and snapshots the body file content the moment the
 * `gh pr comment` call arrives (still on disk — the post's finally removes
 * the temp dir only after the call resolves).
 */
function stubForBranch(branchName: string): Stub {
  const calls: string[] = [];
  const bodyFiles: string[] = [];
  const execFn = async (cmd: string): Promise<{ stdout: string }> => {
    calls.push(cmd);
    if (cmd.includes(`pr list --state open --head ${branchName}`)) {
      return { stdout: JSON.stringify([{ number: 12 }]) };
    }
    if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
      return { stdout: JSON.stringify({ headRefName: branchName, baseRefName: "main" }) };
    }
    if (cmd.includes("pr comment")) {
      // Snapshot the body file NOW (still on disk; the post's finally
      // removes the temp dir only AFTER this call resolves).
      const m = /--body-file (\S+)/.exec(cmd);
      if (m) bodyFiles.push(readFileSync(m[1], "utf8"));
      return { stdout: "" };
    }
    if (cmd.includes("git config --get remote.origin.url")) {
      return { stdout: "git@github.com:o/r.git\n" };
    }
    if (cmd.includes("git remote")) return { stdout: "origin\n" };
    if (cmd.includes("git fetch")) return { stdout: "" };
    if (cmd.includes("patch-id")) return { stdout: "p42 0000" };
    throw new Error(`unexpected exec: ${cmd}`);
  };
  return { execFn, calls, bodyFiles };
}

// A temp dir the post operates in. The forge is FORCED to github so the
// stub's gh reads are exercised deterministically (the env hard override
// wins over the remote URL, which the stub does not fully simulate).
function repoDir(): string {
  process.env.PI_ENSEMBLE_FORGE = "github";
  return mkdtempSync(path.join(tmpdir(), "pi-residuals-1000-repo-"));
}

// ------------------------------------------- #1000 — multi-segment branch,
// branch-lookup path: the posted marker carries the FULL branch name

{
  const dir = repoDir();
  const branch = "feature/issue-1-x";
  try {
    const stub = stubForBranch(branch);
    const note = await postLensResidualDisclosure({
      summary: ISSUES,
      branch,
      cwd: dir,
      execFn: stub.execFn,
    });
    assert(note === "", "multi-segment branch: a successful post returns no note");
    assert(
      stub.calls.some((c) => c.includes("pr comment 12")),
      "…the PR was resolved via the branch lookup (PR 12) and posted to",
    );
    assert(stub.bodyFiles.length === 1, "…and the post wrote exactly one body file");
    // The marker's patch is the FIRST field of the stub's `git patch-id`
    // output (`p42 0000` → `p42` — parsePatchId, review-ledger.ts).
    const expected = `<!-- pi-rukas:lens-residuals branch=${branch} patch=p42 -->`;
    assert(
      stub.bodyFiles[0]?.includes(expected),
      `the posted body carries the FULL branch name in the marker (no segment stripped): ${expected}`,
    );
    assert(
      !stub.bodyFiles.some((b) => b.includes("branch=issue-1-x ")),
      "…and no stripped-branch marker (branch=issue-1-x) appears in the posted body",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- #1000 — end-to-end consistency:
// the marker the poster builds equals the guard's expected marker

{
  const dir = repoDir();
  const branch = "feature/issue-1-x";
  const stub = stubForBranch(branch);
  try {
    const note = await postLensResidualDisclosure({
      summary: summary("ISSUES_FOUND", [
        { severity: "LOW", path: "src/b.ts", line: 1, title: "b finding", lens: "SIMPLICITY" },
      ]),
      branch,
      cwd: dir,
      execFn: stub.execFn,
    });
    assert(note === "", "consistency (branch-lookup path): a successful post returns no note");
    // The guard builds its expected marker from the same bare headRefName
    // (merge-guard.ts: target.headBranch = raw.headRefName) and patchId.
    const guardMarker = lensResidualsMarker(branch, "p42");
    assert(
      stub.bodyFiles.length === 1 && stub.bodyFiles[0].includes(guardMarker),
      "the posted body carries the EXACT marker the merge guard expects for the same headRefName/patchId",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- #1000 — explicit pr param →
// skips the branch lookup, the marker's branch comes from the identity read

{
  const dir = repoDir();
  const branch = "feature/issue-1-x";
  try {
    // A stub that would return a DIFFERENT PR (77) if the branch lookup
    // ran, but the explicit `pr: 12` must be used directly — the identity
    // read is against `pr` alone, and the marker's branch comes from the
    // open PR's correct headRefName.
    const stub = stubForBranch(branch);
    const note = await postLensResidualDisclosure({
      summary: ISSUES,
      branch: "feature/stale",
      pr: 12,
      cwd: dir,
      execFn: stub.execFn,
    });
    assert(note === "", "an explicit pr + successful post returns no note");
    assert(
      !stub.calls.some((c) => c.includes("pr list --state open")),
      "the explicit pr skips the branch→PR list lookup entirely",
    );
    assert(
      stub.calls.some((c) => c.includes("pr view 12 --json headRefName,baseRefName")),
      "…and the identity read is against the explicit pr (12), not the branch's PR",
    );
    assert(
      stub.calls.some((c) => c.includes("git fetch origin feature/issue-1-x main")),
      "…and the patch-id base/head come from the open PR's refs, not the stale branch",
    );
    assert(stub.calls.some((c) => c.includes("pr comment 12")), "the post issues a `gh pr comment` call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- #1000 — multi-segment branch,
// explicit-pr path: same exact marker assertion

{
  const dir = repoDir();
  const branch = "feature/issue-1-x";
  try {
    const stub = stubForBranch(branch);
    const note = await postLensResidualDisclosure({
      summary: summary("ISSUES_FOUND", [
        { severity: "MEDIUM", path: "src/c.ts", line: 7, title: "c finding", lens: "SIMPLICITY" },
      ]),
      branch: "feature/stale",
      pr: 12,
      cwd: dir,
      execFn: stub.execFn,
    });
    assert(note === "", "explicit-pr + multi-segment branch: a successful post returns no note");
    assert(
      !stub.calls.some((c) => c.includes("pr list --state open")),
      "…the explicit pr skips the branch lookup (the marker's branch still comes from the PR identity read)",
    );
    assert(stub.bodyFiles.length === 1, "…and the post wrote exactly one body file");
    const expected = `<!-- pi-rukas:lens-residuals branch=${branch} patch=p42 -->`;
    assert(stub.bodyFiles[0]?.includes(expected), `the explicit-pr path posts the FULL branch name: ${expected}`);
    // End-to-end consistency for the explicit-pr path: the guard's builder
    // with the same (headRefName, patchId) produces the exact posted string.
    assert(
      stub.bodyFiles[0]?.includes(lensResidualsMarker(branch, "p42")),
      "…which equals the marker the merge guard's builder expects (explicit-pr path)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- #1000 — unsafe headRefName
// (contains `-->`): NOT posted (fail closed), the note names the refusal

{
  const dir = repoDir();
  try {
    // A stub whose identity read returns a headRefName that is NOT
    // git-ref-safe: it contains `-->`, which would terminate the
    // HTML-comment marker early (smuggled-comment injection into the post).
    const calls: string[] = [];
    const execFn = async (cmd: string): Promise<{ stdout: string }> => {
      calls.push(cmd);
      if (cmd.includes("pr list --state open")) return { stdout: JSON.stringify([{ number: 12 }]) };
      if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
        return { stdout: JSON.stringify({ headRefName: "feature/x-->", baseRefName: "main" }) };
      }
      if (cmd.includes("git config --get remote.origin.url")) {
        return { stdout: "git@github.com:o/r.git\n" };
      }
      if (cmd.includes("git remote")) return { stdout: "origin\n" };
      if (cmd.includes("git fetch")) return { stdout: "" };
      if (cmd.includes("patch-id")) return { stdout: "p42 0000" };
      if (cmd.includes("pr comment")) {
        throw new Error("a pr comment call MUST NOT happen for an unsafe branch name");
      }
      throw new Error(`unexpected exec: ${cmd}`);
    };
    const note = await postLensResidualDisclosure({
      summary: ISSUES,
      branch: "feature/x-->",
      cwd: dir,
      execFn,
    });
    assert(note !== "", "an unsafe headRefName returns a note (fail closed)");
    assert(/git-ref-safe/.test(note), "…naming the git-ref-safe refusal");
    assert(
      !calls.some((c) => c.includes("pr comment")),
      "…and NOTHING is posted (the guard then refuses — fail closed)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
