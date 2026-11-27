/**
 * lib/lean-prefix-head-scenario — one lean run whose review buys a fix wave the re-review refuses, driven
 * through `runLean` in a real temp repo, for `test-lean-prefix-head.ts`.
 */

import { readFileSync } from "node:fs";
import { leanResultDocument } from "../../src/headless/work-lean-result.ts";
import { runLean } from "../../src/lean/engine.ts";
import { handbackOutcome } from "../../src/lean/handback.ts";
import { reviewOutcome } from "../../src/lean/review.ts";
import { leanStateFile } from "../../src/lean/state.ts";
import type { DispatchSpec } from "../../src/types.ts";
import { CLOCK } from "./lean-engine-fixtures.ts";
import {
  BRANCH,
  blockingFinding,
  carriedLensRound,
  depsWith,
  fixerThatCommits,
  git,
  lensRoundWith,
  makeRepo,
  setup,
} from "./lean-review-fixtures.ts";

export interface Scenario {
  repoRoot: string;
  /** The head pass 1 reviewed: the fix wave's start. */
  head: string;
  code: number;
  /** Every PR comment the review step posted, in order. */
  comments: string[];
  /** The `since` every fix-wave lens call was handed. */
  sinces: (string | undefined)[];
  /** The state file's bytes and the host document, sha-normalised. */
  normalised: string;
}

/**
 * Drive the run. `onFixer` runs inside the fixer's dispatch, before it commits; `repo` resumes an earlier
 * scenario's repo instead of making one.
 */
export async function prefixHeadRun(
  tag: string,
  opts: { onFixer?: (repoRoot: string) => void; repo?: { repoRoot: string; head: string } } = {},
): Promise<Scenario> {
  let repo = opts.repo;
  if (repo === undefined) {
    const made = makeRepo();
    const head = await setup({ ...made, branch: BRANCH, feature: `export const f = "${tag}";\n` });
    repo = { repoRoot: made.repoRoot, head };
  }
  const { repoRoot } = repo;
  const comments: string[] = [];
  const sinces: (string | undefined)[] = [];
  const commit = fixerThatCommits(tag);
  const deps = depsWith({
    lens: async (a) => {
      if (a.wave !== "fix") return lensRoundWith("ISSUES_FOUND", [blockingFinding()]);
      sinces.push(a.since);
      return carriedLensRound(a, [blockingFinding()]);
    },
    dispatch: async (spec: DispatchSpec) => {
      opts.onFixer?.(repoRoot);
      return commit(spec);
    },
    prComment: async (_root, _pr, body) => {
      comments.push(body);
    },
  });
  const run = await runLean({
    repoRoot,
    issue: 7,
    handlers: {
      ready: async () => ({ kind: "ok" }),
      specify: async () => ({ kind: "ok" }),
      build: async () => ({ kind: "ok" }),
      challenge: async () => ({ kind: "none" }),
      verify: async () => ({ kind: "green" }),
      publish: async () => ({ kind: "ok", prUrl: "https://forge.test/o/r/pull/3" }),
      review: (ctx) => reviewOutcome(ctx, deps),
      handback: (ctx) => handbackOutcome(ctx, async () => {}),
      decline: async () => ({ kind: "done" }),
    },
    now: () => CLOCK,
    seed: { baseSha: git(repoRoot, "rev-parse", "main"), branch: BRANCH },
  });
  const state = readFileSync(leanStateFile(repoRoot, 7), "utf8");
  const { doc } = leanResultDocument(run.run, run.code);
  return {
    repoRoot,
    head: repo.head,
    code: run.code,
    comments,
    sinces,
    normalised: normalise(
      [state, JSON.stringify(doc), ...comments, String(run.code)].join("\n"),
      repoRoot,
    ),
  };
}

/** Shas (and 12-char prefixes, matched to a full sha where one appears) numbered in order of appearance and the temp root named, so two runs
 * compare byte for byte. */
function normalise(text: string, repoRoot: string): string {
  const seen = new Map<string, string>();
  let out = text
    .split(repoRoot)
    .join("<ROOT>")
    .replace(/[0-9a-f]{40}/g, (sha) => {
      if (!seen.has(sha)) seen.set(sha, `<SHA${String(seen.size)}>`);
      return seen.get(sha) as string;
    });
  for (const [sha, token] of seen) out = out.split(sha.slice(0, 12)).join(token);
  const short = new Map<string, string>();
  return out.replace(/\b[0-9a-f]{12}\b/g, (prefix) => {
    if (!short.has(prefix)) short.set(prefix, `<SHORT${String(short.size)}>`);
    return short.get(prefix) as string;
  });
}
