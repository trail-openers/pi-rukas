#!/usr/bin/env bun
/**
 * The handoff body is normalised ONCE, in the step, and every leg publishes
 * that one string (the #1788 follow-up review finding).
 *
 * The body reaches the forge through four readers of the same file: the ops
 * child posts `handoff-comment.md`, the in-process fallback `fs.readFile`s it,
 * `postHandoffWithRetry` compares the target's existing comments against
 * the idempotency comparison, and the `handoff-emitted` event records a body the host
 * channel republishes. A rewrite applied at a reader would leave those four
 * disagreeing, and the disagreement that bites is the idempotency check: a
 * comment that already carries the NORMALISED text compared against the raw
 * render does not match, so the driver posts a duplicate handoff.
 *
 * Pinned here in three directions:
 *
 *  1. `handoffCommentBody` normalises for a public target and leaves the exact
 *     paths for a positively private one;
 *  2. `deliverHandoff` posts the string it was handed, and treats a comment
 *     equal to the UN-normalised render as not-yet-posted (so it posts);
 *  3. the same comparison against the normalised body does NOT post again.
 *
 * Offline: fake forge, no model, no network; every path is built from this
 * test's own scratch dirs.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Forge } from "../src/forge.ts";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { normaliseDriverPublishPaths } from "../src/public-hygiene-normalise.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import { handoffCommentBody } from "../src/work-driver-handoff-body.ts";
import { deliverHandoff } from "../src/work-driver-handoff-deliver.ts";
import { initialState } from "../src/workflow-state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");
const root = mkdtempSync(path.join(tmpdir(), "handoff-body-"));
// The scratch directory the DRIVER publishes from: repository, denylist, body
// file. Everything hygiene is asked about lives here.
const home = path.join(root, "home", "example-person");
const repo = path.join(root, "work", "example-project");
// The transcript lives in a SEPARATE tree, because that is where a real one
// lives: under the operator's home, not under the repository. If it sat under
// `root` it would also sit under the repository spelling, which the rewrite
// applies before the home spelling, and the path would come back `<repo>`-folded
// rather than `~`-folded — the assertion would then be judging the wrong leg.
mkdirSync(path.join(home, ".pi"), { recursive: true });
mkdirSync(path.join(repo, "tmp", "issue-9"), { recursive: true });
const denylist = path.join(root, "denylist");
writeFileSync(denylist, `# synthetic\n${TERM}\n`, "utf8");

const NOT_USED = (async () => {
  throw new Error("not used by this test");
}) as never;

/** A forge whose comment read and post are both recorded. */
function mkForge(comments: string[]): { forge: Forge; posted: string[]; seen: string[] } {
  const posted: string[] = [];
  const seen: string[] = [];
  const forge = {
    forge: "github" as const,
    host: "github.com",
    owner: "example-owner",
    repo: "example-repo",
    cwd: repo,
    issueComment: async (_n: number, body: string) => {
      posted.push(body);
      return "https://github.com/example-owner/example-repo/issues/9#issuecomment-7";
    },
    issueComments: async () => {
      seen.push("issueComments");
      return comments.map((body, i) => ({
        id: i + 1,
        body,
        url: `https://github.com/example-owner/example-repo/issues/9#issuecomment-${i}`,
        createdAt: undefined,
      }));
    },
    labelCreate: async () => undefined,
    labelAdd: async () => undefined,
    labelRemove: async () => undefined,
    issueView: async () => ({
      number: 9,
      title: "t",
      body: "",
      state: "OPEN" as const,
      url: "",
      author: "x",
      labels: [{ name: "needs-human-attention", id: 1, color: "FFAA00", description: "" }],
      createdAt: undefined,
      updatedAt: undefined,
    }),
    prView: NOT_USED,
    prComments: NOT_USED,
    prComment: NOT_USED,
    issueCreate: NOT_USED,
    issueEdit: NOT_USED,
    issueSearch: NOT_USED,
    prList: NOT_USED,
    prCreate: NOT_USED,
    prMerge: NOT_USED,
    prDiff: NOT_USED,
    prChecks: NOT_USED,
    ciWatch: NOT_USED,
    ciRun: NOT_USED,
    mergeReadiness: NOT_USED,
    repoSettings: NOT_USED,
  } as unknown as Forge;
  return { forge, posted, seen };
}

/** A state whose rendered handoff names a path under the home directory. */
function stateWith(transcriptPath: string) {
  const s = initialState(9);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      handoffSnapshot: {
        modifiedFiles: [],
        unstagedCount: 0,
        stagedCount: 0,
        branchExists: true,
        branchPushed: false,
        capturedAt: 1,
        // The host path the renderer prints verbatim: a worktree under the
        // repository that the recovery commands point the operator at.
        committedWork: [
          {
            worktreeId: "default",
            path: path.join(repo, ".worktrees", "issue-9-default"),
            headSha: "1111111111111111111111111111111111111111",
            ahead: 2,
          },
        ],
      },
      // The consolidated-worktree record is what makes the renderer print a
      // host path — without it there is nothing for the rewrite to find.
      status: "handoff" as const,
    },
    eventLog: [
      { kind: "step-started", step: "develop", at: 1 },
      // The shape the renderer actually prints a transcript path from: a
      // completed dispatch whose `transcriptPath` names a file under the home
      // directory. This is the text the rewrite exists to make safe to publish.
      {
        kind: "dispatch-completed",
        at: 2,
        step: "develop",
        role: "developer",
        jobId: "j",
        label: "develop",
        ms: 1_000,
        transcriptPath: transcript,
      },
    ],
  };
}

// Where a real transcript lives, and the tree the seam's default home spelling
// collapses. `os.homedir()` is what the seam asks (the verify-loop's isolated
// `HOME` never reaches it, so no env injection could name a different tree):
// building the path from the same source the rewrite reads is what makes this
// the production shape rather than a path nothing would ever fold. It is a real
// host path, which is the point — a public target must not carry it and a
// positively private one must.
const hostHome = os.homedir();
const transcript = path.join(hostHome, ".pi", "agent", "ensemble-runs", "run-developer.json");
const ctx = { repoRoot: repo };

await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: denylist }, async () => {
  resetDenylistCacheForTests();
  resetVisibilityCacheForTests();

  // ── 1. the body itself, for a public target.
  const publicCheck = await handoffCommentBody(stateWith(transcript), ctx, {
    forge: "github",
    host: "github.com",
    owner: "example-owner",
    repo: "example-repo",
  } as unknown as Forge);
  assert(publicCheck.refusal === undefined, `the public body is not refused (${publicCheck.refusal})`);
  const publicBody = publicCheck.body ?? "";
  assert(publicBody.includes("<!-- pi-rukas:handoff"), "the handoff marker is on the body");
  assert(publicBody.includes("~/"), `the home path is normalised (${publicBody.slice(0, 40)})`);
  assert(!publicBody.includes(home), "…and the host's home directory is gone from the bytes");

  // ── 2. the fallback posts the string it was handed, and an existing comment
  // equal to the UN-normalised render is NOT treated as already posted.
  const bodyFile = path.join(repo, "tmp", "issue-9", "handoff-comment.md");
  writeFileSync(bodyFile, publicBody, "utf8");
  const rawRender = `the transcript is at ${transcript}`;
  const unposted = mkForge([rawRender]);
  const first = await deliverHandoff({
    issue: 9,
    prNumber: undefined,
    forge: unposted.forge,
    handoffBodyPath: bodyFile,
    body: publicBody,
    commentUrl: undefined,
    labelApplied: true,
    dispatchFailed: false,
  });
  assert(
    unposted.posted.length === 1 && unposted.posted[0] === publicBody,
    "the fallback posts the normalised string it was given, byte for byte",
  );
  assert(
    first.commentUrl !== undefined,
    "a comment carrying the UN-normalised render is not treated as the handoff already posted",
  );

  // ── 3. the same comparison against a comment that DOES carry the normalised
  // body posts nothing (the dedupe the file-read version used to lose).
  const already = mkForge([publicBody]);
  await deliverHandoff({
    issue: 9,
    prNumber: undefined,
    forge: already.forge,
    handoffBodyPath: bodyFile,
    body: publicBody,
    commentUrl: undefined,
    labelApplied: true,
    dispatchFailed: false,
  });
  assert(
    already.posted.length === 0,
    "…and a comment equal to the normalised body is not re-posted",
  );

  // ── 4. a caller with nothing to post posts nothing: `body` is REQUIRED
  // (#1820), because the file on disk is bytes the hygiene seam never judged.
  const fellBack = mkForge([]);
  const noBody = await deliverHandoff({
    issue: 9,
    prNumber: undefined,
    forge: fellBack.forge,
    handoffBodyPath: bodyFile,
    body: "",
    commentUrl: undefined,
    labelApplied: true,
    dispatchFailed: false,
  });
  assert(
    fellBack.posted.length === 0,
    "an empty body is never posted from the file — the seam's bytes or nothing",
  );
  assert(noBody.commentUrl === undefined, "and no comment URL is claimed for it");
  // The file that predates the seam is still on disk, unchanged: what changed is
  // that posting no longer reads it.
  assert(
    readFileSync(bodyFile, "utf8") === publicBody,
    "the earlier body file is unchanged",
  );

  // ── 5. a positively private target keeps the exact paths, and nothing in the
  // body was rewritten.
  resetVisibilityCacheForTests();
  const privateCheck = await handoffCommentBody(
    stateWith(transcript),
    ctx,
    {
      forge: "github",
      host: "github.com",
      owner: "example-owner",
      repo: "example-repo",
    } as unknown as Forge,
    async () => true,
  );
  assert(privateCheck.refusal === undefined, "a private handoff is not refused");
  const privateBody = privateCheck.body ?? "";
  assert(
    privateBody.includes(transcript),
    "a private repository's handoff keeps the real path — an operator reads the file it names",
  );
  assert(
    !privateBody.includes("relative to `~`"),
    "…and carries no note about placeholders it never used",
  );

  // ── 6. the hatch off: no rewrite, and the bytes are the render's.
  await withEnv({ PI_ENSEMBLE_PUBLIC_HYGIENE: "0" }, async () => {
    resetVisibilityCacheForTests();
    const offCheck = await handoffCommentBody(stateWith(transcript), ctx, undefined);
    const off = offCheck.body ?? "";
    assert(off.includes(transcript), "with the guard off the paths are untouched");
    assert(
      readFileSync(bodyFile, "utf8") === publicBody,
      "…and the earlier body file is unchanged",
    );
  });
});

rmSync(root, { recursive: true, force: true });
process.exit(exit);
