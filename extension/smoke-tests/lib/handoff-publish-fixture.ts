/**
 * Handoff-body publish fixtures — the state, forge and scratch world the
 * handoff-body tests share, so each case reads as the behaviour it pins rather
 * than as setup.
 *
 * Kept out of the test files because two suites drive the same fixture (the
 * normalisation suite and the refusal suite) and a second copy of a fixture is a
 * second thing that drifts from the renderer.
 */

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Forge } from "../../src/forge.ts";
import { initialState } from "../../src/workflow-state-update.ts";

/** The scratch world: a home tree, a repository, and a transcript inside the host's home. */
export interface HandoffFixture {
  /** The scratch root the caller removes. */
  root: string;
  /** A directory standing in for a home tree (used for the "other home" cases). */
  home: string;
  /** The scratch repository root. */
  repo: string;
  /** Where a real transcript lives — built from `os.homedir()`, the seam's own source. */
  transcript: string;
  /** Path to the body file, as `runHandoff` writes it. */
  bodyFile: string;
  /** The denylist file the suites point `PI_ENSEMBLE_PUBLIC_DENYLIST` at. */
  denylist: string;
  /** A synthetic private term. */
  term: string;
}

export function makeFixture(root: string): HandoffFixture {
  const home = path.join(root, "home", "example-person");
  const repo = path.join(root, "work", "example-project");
  const scratch = path.join(repo, "tmp", "issue-9");
  for (const dir of [home, path.join(repo, ".worktrees", "issue-9-default"), scratch]) {
    mkdirSync(dir, { recursive: true });
  }
  const term = ["example", "private", "host"].join("-");
  return {
    root,
    home,
    repo,
    transcript: path.join(os.homedir(), ".pi", "agent", "ensemble-runs", "run-developer.json"),
    bodyFile: path.join(scratch, "handoff-comment.md"),
    denylist: path.join(root, "denylist"),
    term,
  };
}

/** A forge stub recording what was posted, and answering the reads the seam makes. */
export function mkForge(existingComments: string[]) {
  const posted: string[] = [];
  const NOT_USED = (async () => {
    throw new Error("not used");
  }) as unknown as () => never;
  const forge = {
    forge: "github",
    owner: "example-owner",
    repo: "example-repo",
    host: "github.com",
    issueComment: async (_n: number, body: string) => {
      posted.push(body);
      return "https://github.com/example-owner/example-repo/issues/9#issuecomment-1";
    },
    issueComments: async () => existingComments.map((body) => ({ body })),
    prComments: async () => existingComments.map((body) => ({ body })),
    labelCreate: async () => undefined,
    labelAdd: async () => undefined,
    labelView: async () => ["needs-human-attention"],
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
  return { forge, posted };
}

/** A state whose rendered handoff names a transcript path and a worktree path. */
export function stateWith(fixture: HandoffFixture) {
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
        committedWork: [
          {
            worktreeId: "default",
            path: path.join(fixture.repo, ".worktrees", "issue-9-default"),
            headSha: "1111111111111111111111111111111111111111",
            ahead: 2,
          },
        ],
      },
      status: "handoff" as const,
    },
    eventLog: [
      { kind: "step-started", step: "develop", at: 1 },
      {
        kind: "dispatch-completed",
        at: 2,
        step: "develop",
        role: "developer",
        jobId: "j",
        label: "develop",
        ms: 1_000,
        transcriptPath: fixture.transcript,
      },
    ],
  };
}

/** A public-visibility executor: the `gh api` answer is "not private". */
export const publicExec = async () => ({ stdout: "false\n" });

/** An executor whose visibility read blows up — a failed lookup must still check. */
export const throwingExec = async () => {
  throw new Error("gh unreachable");
};
