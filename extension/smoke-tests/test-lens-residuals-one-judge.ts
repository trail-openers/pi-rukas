#!/usr/bin/env bun
/**
 * lens-residuals-one-judge (#1820 lens round 1, M3) — the residual disclosure
 * runs the public-text seam ONCE, and the body that posts is the text it returned.
 *
 * ## The defect this file pins
 *
 * `postLensResidualDisclosure` ran `driverPublishCheck` on the body itself and
 * then handed the same body to `postPrComment`, whose `checkPublicText` ran the
 * identical seam a second time. Two judges, one body: they could only agree by
 * coincidence, the precheck's rewritten text was thrown away before the second
 * judge saw it, and the visibility question was paid for twice on every capped
 * cycle's disclosure. Now the seam below is the single judge and the bytes it
 * returns are the bytes `withBodyFile` writes.
 *
 * ## What each block proves
 *
 * 1. The disclosure posts once, with one body file, and that file carries the
 *    fold (`<repo>/`) — i.e. the judge's own output, not the raw render.
 * 2. The seam was asked exactly ONCE for this body (one visibility lookup, one
 *    matcher pass), counted through the executor the post is given.
 * 3. A body the matcher refuses posts nothing at all.
 *
 * Offline, stubbed exec, synthetic term; no real host path or name appears.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import { postLensResidualDisclosure } from "../src/lens-review-residuals.ts";
import type { LensReviewSummary } from "../src/lens-review.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");
const scratch = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "residuals-judge-"));
const denylistPath = path.join(scratch, "denylist");
writeFileSync(denylistPath, `# synthetic\n${TERM}\n`, "utf8");

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

const FINDING = {
  severity: "MEDIUM",
  path: "src/a.ts",
  line: 10,
  // The finding's own title names a path under the repo: this is the text the
  // fold must rewrite before anything is posted.
  title: "reads /repo-root-placeholder/tmp/verify.log",
  lens: "SIMPLICITY",
};

interface Stub {
  execFn: (cmd: string, o?: { argv?: string[] }) => Promise<{ stdout: string }>;
  calls: string[];
  visibilityLookups: number;
  bodyFiles: string[];
}

/** Canned answers for the post's identity reads, counting visibility lookups. */
function stubFor(branch: string, repoDir: string, privateAnswer = false): Stub {
  const calls: string[] = [];
  const bodyFiles: string[] = [];
  let visibilityLookups = 0;
  const execFn = async (cmd0: string, o?: { argv?: string[] }) => {
    const cmd = commandOf(cmd0, o);
    calls.push(cmd);
    if (cmd.includes(`pr list --state open --head ${branch}`)) {
      return { stdout: JSON.stringify([{ number: 12 }]) };
    }
    if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
      return { stdout: JSON.stringify({ headRefName: branch, baseRefName: "main" }) };
    }
    if (cmd.includes("pr comment")) {
      const m = /--body-file (\S+)/.exec(cmd);
      if (m) bodyFiles.push(readFileSync(m[1], "utf8"));
      return { stdout: "" };
    }
    // The seam's visibility question — `gh api repos/OWNER/REPO --jq .private`.
    if (cmd.includes("api repos/")) {
      visibilityLookups++;
      return { stdout: `${privateAnswer}\n` };
    }
    if (cmd.includes("git config --get remote.origin.url")) {
      return { stdout: "git@github.com:o/r.git\n" };
    }
    if (cmd.includes("remote get-url")) return { stdout: "https://github.com/o/r.git\n" };
    if (cmd.includes("git remote")) return { stdout: "origin\n" };
    if (cmd.includes("symbolic-ref")) return { stdout: "origin/main\n" };
    if (cmd.includes("git merge-base")) return { stdout: "mb0000\n" };
    if (cmd.includes("patch-id")) return { stdout: "p42 0000" };
    if (cmd.startsWith("git ")) return { stdout: "" };
    void repoDir;
    return { stdout: "" };
  };
  return { execFn, calls, get visibilityLookups() { return visibilityLookups; }, bodyFiles } as Stub;
}

const repoDir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "residuals-judge-repo-"));
// A host path under the repo that the fold must rewrite out of the body.
const hostPath = path.join(repoDir, "tmp", "verify.log");

await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath }, async () => {
  resetDenylistCacheForTests();
  resetVisibilityCacheForTests();
  process.env.PI_ENSEMBLE_FORGE = "github";

  // ── 1 + 2: one post, one judge, and the posted bytes are the judge's output ─
  const branch = "feature/issue-1-x";
  const stub = stubFor(branch, repoDir);
  const note = await postLensResidualDisclosure({
    summary: summary("ISSUES_FOUND", [{ ...FINDING, title: `reads ${hostPath}` }]),
    branch,
    cwd: repoDir,
    execFn: stub.execFn,
  });
  assert(note === "", `a successful post returns no note (got ${JSON.stringify(note)})`);
  assert(stub.calls.filter((c) => c.includes("pr comment 12")).length === 1, "posted exactly once");
  assert(stub.bodyFiles.length === 1, "…with exactly one body file");
  const posted = stub.bodyFiles[0] ?? "";
  assert(
    posted.includes("<!-- pi-rukas:lens-residuals"),
    "the disclosure marker is on the posted body",
  );
  assert(
    !posted.includes(hostPath) && posted.includes("<repo>/"),
    `the posted bytes are the seam's REWRITTEN output, not the raw render (${JSON.stringify(posted.slice(0, 120))})`,
  );
  assert(
    stub.visibilityLookups === 1,
    `the public/private question was asked ONCE for this body (got ${stub.visibilityLookups})`,
  );

  // ── 3: a refused body posts nothing ───────────────────────────────────────
  resetVisibilityCacheForTests();
  const dirty = stubFor(branch, repoDir);
  const dirtyNote = await postLensResidualDisclosure({
    summary: summary("ISSUES_FOUND", [
      { ...FINDING, title: `the build failed on ${TERM}` },
    ]),
    branch,
    cwd: repoDir,
    execFn: dirty.execFn,
  });
  assert(
    dirtyNote.includes("FAILED") && dirtyNote.includes("disclosure"),
    `a body carrying a denylist term yields the failed-disclosure note, not a post (got ${JSON.stringify(dirtyNote.slice(0, 120))})`,
  );
  assert(
    !dirtyNote.includes(TERM),
    "…and the note never repeats the matched term",
  );
  assert(
    dirty.bodyFiles.length === 0 && !dirty.calls.some((c) => c.includes("pr comment")),
    "…and no comment was posted, because the single judge refused before withBodyFile ran",
  );
});

rmSync(scratch, { recursive: true, force: true });
rmSync(repoDir, { recursive: true, force: true });
process.exit(exit);
