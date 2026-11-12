/**
 * forge — unified GitHub (gh) / GitLab (glab) adapter (S2 of epic #608).
 *
 * Normalizes field names, states, and CLI shapes behind one TypeScript API.
 * S1's `detectForge` decides the forge; this module does the work against it.
 *
 * Sub-modules: `forge-types.ts` (types), `forge-commands.ts` (cmd builders),
 * `forge-mapping.ts` (JSON mappers), `forge-merge.ts` (merge readiness).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execp } from "./exec.ts";
import { GH_TERMINAL_CI, GL_TERMINAL_CI, terminalCiFor } from "./forge-ci-terminal.ts";
import { ciRun as ciRunImpl, ciWatch as ciWatchImpl } from "./forge-ci.ts";
import * as cmds from "./forge-commands.ts";
import { listIssueComments, listPrComments, postPrComment } from "./forge-comments.ts";
import type { PublicTextCheck } from "./forge-comments.ts";
import type { ForgeDetection, ForgeType } from "./forge-detect.ts";
import { type LabelListResult, labelOps } from "./forge-label-ops.ts";
import { mapIssueSearchReply, mapPrListReply } from "./forge-list.ts";
import {
  ForgeFieldError,
  asArray,
  asRecord,
  makeMinimalIssue,
  makeMinimalPr,
  mapGhChecks,
  mapGhComment,
  mapGhIssue,
  mapGhIssueWithNumber,
  mapGhPr,
  mapGhPrWithNumber,
  mapGhRepo,
  mapGlIssue,
  mapGlMr,
  mapGlPipelineJobs,
  mapGlRepo,
  parsePlainTextIssue,
  parsePlainTextPr,
  parsePrNumberFromResponse,
} from "./forge-mapping.ts";
import { checkGithubReadiness, checkGitlabReadiness, composeGlReadiness } from "./forge-merge.ts";
import { glPipelineJobs, glPipelineJobsAt } from "./forge-pipeline.ts";
import type { VisibilityFn } from "./public-hygiene-visibility.ts";
import { isFullCommitSha } from "./review-head-sha.ts";
import { forgePublishCheck } from "./work-driver-commit-hygiene.ts";
export type { CiWatchOpts, CiWatchResult, Forge, ForgeExecFn } from "./forge-types.ts";
import type {
  CiWatchOpts,
  CiWatchResult,
  FileIssueOpts,
  Forge,
  ForgeExecFn,
  MergeReadiness,
  MergeReadinessResult,
  NormalizedCICheck,
  NormalizedCIRun,
  NormalizedComment,
  NormalizedIssue,
  NormalizedLabel,
  NormalizedPullRequest,
  NormalizedRepo,
} from "./forge-types.ts";

// ── The Forge object ─────────────────────────────────────────────────────

export interface CreateForgeOpts {
  /** The exec seam (default `execp`). */
  execFn?: ForgeExecFn;
  /** The repo root (default `process.cwd()`). */
  cwd?: string;
  /**
   * Per-call executor options merged into every adapter exec (S4 driver
   * sites use this to carry their per-attempt deadline, e.g. the explore
   * issue-body fetch's 45s timeout). `cwd` is always the forge's repo root.
   */
  execOpts?: { timeout?: number; maxBuffer?: number };
  /**
   * The public-only gate's resolver seam (#1788 round 2): the function that
   * asks whether a repository is private. Tests hand in a stub so the offline
   * suite never dials a forge; production leaves it out and the visibility
   * module asks `gh` through the adapter's own executor. Same shape as every
   * other visibility seam in this guard.
   */
  visibility?: VisibilityFn;
}

/**
 * Build a Forge from S1's detection result. `det.forge` must be `github`
 * or `gitlab` — `unknown` rejects up front, because every operation below
 * is forge-specific and there is no third path to guess.
 */
export function createForge(det: ForgeDetection, opts: CreateForgeOpts = {}): Forge {
  if (det.forge === "unknown") {
    throw new Error(`createForge: forge is "unknown" (source=${det.source}) — refusing to guess`);
  }
  const execFn = opts.execFn ?? execp;
  const cwd = opts.cwd ?? process.cwd();
  const extraOpts = opts.execOpts ?? {};
  const forge = det.forge;
  const owner = det.url ? (parseOwner(det.url) ?? "") : "";
  const repo = det.url ? (parseRepo(det.url) ?? "") : "";

  /**
   * #1261 — default per-call exec timeout. `gh` calls against a healthy API
   * complete in well under 60 s; a half-open connection or a stalled proxy
   * otherwise hangs the driver's entry and handoff paths forever (no event
   * persisted, no terminal status, no handoff artifact). A caller that
   * supplies its own `execOpts.timeout` (e.g. the explore body fetch's 45 s)
   * overrides this via the spread below.
   */
  const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

  /**
   * #1788 — the driver's own publishes are checked here, not by the tool_call
   * hook: every issue and PR write below goes through `run`, an in-process exec
   * the `tool_call` hook never sees. The rule, the public-only gate and the
   * path rewrite (`~` / `<repo>`, so the posted bytes are the judged bytes) all
   * live in `work-driver-commit-hygiene.ts`'s `forgePublishCheck`, which this
   * adapter calls with its own slug, cwd and exec bound.
   */
  const checkPublicText = (label: string, text: string): Promise<PublicTextCheck> =>
    forgePublishCheck(label, text, forgeCommand(label), {
      cwd,
      exec: (cmd, execOpts) => execFn(cmd, { ...execOpts, cwd }),
      visibility: opts.visibility,
      timeoutMs: extraOpts.timeout,
      // The adapter's own slug is the target: no command string has to be
      // parsed to work out which repository a `gh pr create` writes to when the
      // adapter was built from that repository's remote.
      target: owner !== "" && repo !== "" ? { owner, repo, host: det.host } : undefined,
    });

  /**
   * A command shape for the target resolver, built from the label. The text is
   * never read from it — it exists only so the resolver's `gh`-noun rules and
   * the `visibility` seam have the same shape they get everywhere else. When the
   * adapter already knows its slug, `target` above short-circuits this entirely.
   */
  const forgeCommand = (label: string): string =>
    label.includes("merge") ? "gh pr merge" : label.includes("comment") ? "gh pr comment" : "gh";

  /**
   * The explicit no-op the READ seams pass. `CommentSeamDeps.checkPublicText`
   * is REQUIRED so a post seam cannot arrive without one; a read seam has
   * nothing to publish, so it says so at the call site rather than letting the
   * type decide what absent meant.
   */
  const NO_PUBLIC_TEXT_CHECK = (): Promise<PublicTextCheck> =>
    Promise.resolve({ text: "", rewritten: false });

  const run = async <T>(cmd: string, map: (stdout: string) => T): Promise<T> => {
    const { stdout } = await execFn(cmd, {
      cwd,
      maxBuffer: 512 * 1024,
      timeout: DEFAULT_EXEC_TIMEOUT_MS,
      ...extraOpts,
    });
    return map(stdout);
  };

  /**
   * The raw MR reply of the most recent readiness read, per MR number.
   *
   * `mapGlMr` keeps no commit oid and the readiness result names none, so a
   * caller that must state WHICH commit its verdict is about has exactly one
   * place to read it: the reply the composition already consumed. Caching it is
   * the alternative to a second `glab api` of a moving MR, whose reply could
   * describe a different commit than the one the verdict was composed from —
   * precisely the two-moments defect the adapter exists to prevent. Best-effort
   * by construction: only the GitLab readiness read fills it, and a caller
   * reading a number that was never read gets `undefined` rather than a stale
   * row from another MR.
   */
  const lastMrRows = new Map<number, Record<string, unknown>>();

  /**
   * Write the body to a temp file, run the operation that takes the file
   * path, then clean up. The temp file is the seam for the GitLab
   * `description=@file` / `--body-file` conventions.
   */
  const withBodyFile = async <T>(
    prefix: string,
    body: string,
    withFile: (file: string) => Promise<T>,
  ): Promise<T> => {
    const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "x";
    const dir = mkdtempSync(join(tmpdir(), `forge-${safe}-`));
    const file = join(dir, "body.md");
    try {
      writeFileSync(file, body, "utf8");
      return await withFile(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  return {
    forge,
    host: det.host,
    owner,
    repo,
    cwd,

    // ── Issues ────────────────────────────────────────────────────────────

    issueView: (number) =>
      run(cmds.issueViewCmd(forge, number), (stdout) => {
        if (forge === "github") {
          const trimmed = stdout.trim();
          if (trimmed && !trimmed.startsWith("{") && !trimmed.startsWith("["))
            return parsePlainTextIssue(stdout, number);
          return mapGhIssueWithNumber(asRecord(stdout), number);
        }
        return mapGlIssue(asRecord(stdout));
      }),

    issueCreate: async (title, body, createOpts) => {
      // #1788 — title and body are checked before the temp file is even
      // written, so a refused publish writes nothing anywhere. A throw here
      // reaches the driver's existing forge-error handling. The body written to
      // the file is the CHECKED body, so the bytes posted are the bytes judged.
      const checkedTitle = (await checkPublicText("issue title", title)).text;
      const checkedBody = (await checkPublicText("issue body", body)).text;
      return withBodyFile(`create-${checkedTitle.slice(0, 16)}`, checkedBody, (file) =>
        run(cmds.issueCreateCmd(forge, checkedTitle, file, createOpts?.labels ?? []), (stdout) => {
          if (forge === "github") {
            // `gh issue create` has no `--json` — it prints the created issue's URL
            // as plain text. `parsePrNumberFromResponse` handles both the plain
            // URL and a JSON payload (forward-compat with a future `gh` that adds
            // `--json` to create). A non-URL, non-JSON stdout must reject, NOT map
            // silently to number 0.
            const parsed = parsePrNumberFromResponse(stdout);
            if (!parsed) {
              throw new Error(
                `forge issue create: could not parse issue number from response: ${stdout
                  .trim()
                  .slice(0, 120)}`,
              );
            }
            return makeMinimalIssue(parsed);
          }
          // `glab issue create` (no --output json) prints the created issue's
          // URL as plain text — the same shape the GitHub path handles above.
          // Its own `prCreate` sibling on this forge already tolerates BOTH
          // shapes (JSON or bare URL); this path must agree.
          const parsedGl = parsePrNumberFromResponse(stdout);
          if (!parsedGl) {
            throw new Error(
              `forge issue create: could not parse issue number from response: ${stdout
                .trim()
                .slice(0, 120)}`,
            );
          }
          try {
            return mapGlIssue(asRecord(stdout));
          } catch {
            return makeMinimalIssue(parsedGl);
          }
        }),
      );
    },

    issueEdit: async (number, body) => {
      const checkedBody = (await checkPublicText("issue body", body)).text;
      return withBodyFile(`edit-${number}`, checkedBody, (file) =>
        run(cmds.issueEditCmd(forge, number, file), (stdout) => {
          if (forge === "github") return mapGhIssue(asRecord(stdout));
          return mapGlIssue(asRecord(stdout));
        }),
      );
    },

    issueComment: async (number, body) => {
      const checkedBody = (await checkPublicText("issue comment", body)).text;
      return withBodyFile(`comment-${number}`, checkedBody, (file) =>
        run(cmds.issueCommentCmd(forge, number, file), (stdout) => stdout),
      );
    },

    issueComments: (number) =>
      listIssueComments(
        { forge, run, withBodyFile, checkPublicText: NO_PUBLIC_TEXT_CHECK },
        number,
      ),

    issueSearch: (query, opts) =>
      run(cmds.issueSearchCmd(forge, query, opts), (stdout) => mapIssueSearchReply(forge, stdout)),

    // ── Pull requests / MRs ───────────────────────────────────────────────

    prView: (number) =>
      run(cmds.prViewCmd(forge, number), (stdout) => {
        if (forge === "github") {
          const trimmed = stdout.trim();
          if (trimmed && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
            // Plain-text state: use as the state, rest defaults.
            const p = parsePlainTextPr(stdout, number);
            p.state = trimmed.toUpperCase() as NormalizedPullRequest["state"];
            return p;
          }
          return mapGhPrWithNumber(asRecord(stdout), number);
        }
        return mapGlMr(asRecord(stdout));
      }),

    // The bare-number tolerance lives in forge-list.ts, not here: it looks like
    // dead defensive code and is not, so it is written where it is visible.
    prList: (opts) => run(cmds.prListCmd(forge, opts), (stdout) => mapPrListReply(forge, stdout)),

    prCreate: async (title, headBranch, body, opts) => {
      const checkedTitle = (await checkPublicText("pull request title", title)).text;
      const checkedBody = (await checkPublicText("pull request body", body)).text;
      return withBodyFile(`pr-${headBranch.slice(0, 16)}`, checkedBody, (file) =>
        run(cmds.prCreateCmd(forge, checkedTitle, headBranch, file, opts ?? {}), (stdout) => {
          // Tolerate both JSON (from --json flag) and plain-text URL responses.
          const parsed = parsePrNumberFromResponse(stdout);
          if (!parsed) {
            throw new Error(
              `forge pr create: could not parse PR number from response: ${stdout.trim().slice(0, 120)}`,
            );
          }
          if (forge === "github") {
            try {
              return mapGhPrWithNumber(asRecord(stdout), parsed.number);
            } catch {
              return makeMinimalPr(parsed);
            }
          }
          try {
            return mapGlMr(asRecord(stdout));
          } catch {
            return makeMinimalPr(parsed);
          }
        }),
      );
    },

    prMerge: async (
      number,
      headOid,
      method: "squash" | "merge" | "rebase" = "squash",
      subject?: string,
    ) => {
      // #1788 — the squash subject a driver composes from the issue title is
      // published as the commit message on main, so it is a public text surface
      // like a title or a body, and it is checked before the merge runs. A
      // merge is the one forge write that cannot be undone from here.
      const mergeSubject =
        subject === undefined
          ? undefined
          : (await checkPublicText("merge commit subject", subject)).text;
      // #1533 — the pin is part of this seam's contract, so a call that cannot
      // name the head it approves fails HERE rather than emitting an unpinned
      // command. The adapter is the one place the command is built.
      if (!isFullCommitSha(headOid)) {
        throw new Error(
          `pr merge of PR ${number} refuses: the head OID to pin is missing or not a full 40-char SHA`,
        );
      }
      return run(cmds.prMergeCmd(forge, number, headOid, method, mergeSubject), (stdout) => stdout);
    },

    prReady: (number) => run(cmds.prReadyCmd(forge, number), () => undefined),

    // #1398 — the draft direction. Unlike `prReady` this must NOT be a
    // fire-and-forget: a command that exits 0 without changing anything would
    // leave the PR mergeable and the cycle believing otherwise, so
    // `rearmDraftForReview` reads the forge back after it.
    prDraft: (number) => run(cmds.prDraftCmd(forge, number), () => undefined),

    prDiff: (number) => run(cmds.prDiffCmd(forge, number), (stdout) => stdout),

    prComments: (number) =>
      listPrComments({ forge, run, withBodyFile, checkPublicText: NO_PUBLIC_TEXT_CHECK }, number),

    // #775 — post a comment on a PR (the in-process handoff fallback seam).
    prComment: (number, body) =>
      postPrComment({ forge, run, withBodyFile, checkPublicText }, number, body),

    prChecks: async (number) => {
      if (forge === "github") {
        return run(cmds.prChecksCmd(forge, number), (stdout) => {
          const parsed = JSON.parse(stdout || "[]");
          if (!Array.isArray(parsed)) throw new Error("forge: checks not an array");
          return mapGhChecks(parsed);
        });
      }
      // GitLab: list the MR's pipelines, take the most recent, list its jobs.
      // A list that ran past the page this read asked for is reported as the
      // empty set rather than as the page it saw: a caller must never receive a
      // partial job list it could grade as complete, and every caller already
      // refuses "no checks reported" as the absence of evidence.
      const pipelines = await run(
        `glab api /projects/:id/merge_requests/${number}/pipelines`,
        (s) => {
          const parsed = JSON.parse(s || "[]");
          if (!Array.isArray(parsed)) throw new Error("forge: pipelines not an array");
          return parsed as Record<string, unknown>[];
        },
      );
      const latest = pipelines[0];
      if (!latest || typeof latest.id !== "number") return [];
      const read = await glPipelineJobs(run, latest.id);
      // A list that ran past the page it read is reported as the empty set rather
      // than as the page it saw: a caller must never receive a partial job list it
      // could grade as complete, and every caller already refuses "no checks
      // reported" as the absence of evidence.
      return read.truncated ? [] : read.rows;
    },

    // The job rows of ONE named pipeline, plus the commit that pipeline says it
    // built — the ONE jobs read a `ci` poll makes. `prChecks` takes the newest row
    // of the MR's pipelines list and keeps only the rows, so a caller that must say
    // which commit they ran at — lean's `ci` step, which refuses to grade a foreign
    // pipeline — needs this arm; the `/pipelines/:id` row carries the `sha` the jobs
    // list does not. `truncated` says the list ran past its page: the caller refuses
    // rather than grading an incomplete list.
    glPipelineJobs: (pipelineId) =>
      glPipelineJobsAt(run, pipelineId, cmds.pipelineViewCmd(pipelineId)),

    // ── CI ────────────────────────────────────────────────────────────────

    ciWatch: (runId, watchOpts) => ciWatchImpl(execFn, forge, cwd, owner, repo, runId, watchOpts),

    ciRun: (id) => ciRunImpl(execFn, forge, cwd, owner, repo, id),

    // ── Merge readiness (SAFETY-CRITICAL) ─────────────────────────────────

    mergeReadiness: (number, opts) => {
      if (forge === "github") return checkGithubReadiness(execFn, cwd, number, opts);
      return checkGitlabReadiness(execFn, cwd, number, opts, (raw) => {
        lastMrRows.set(number, raw);
      });
    },

    // The readiness read's own MR reply, for the one caller that must name the
    // commit the verdict was composed at (see `lastMrRows`).
    lastMrRow: (number) => lastMrRows.get(number),

    // ── Labels ────────────────────────────────────────────────────────────
    // The family lives in forge-label-ops.ts (500-line seam) and receives this
    // same `run` seam, so its argv goes through the same exec defaults.
    ...labelOps({ forge, run }),

    // ── Repo settings ─────────────────────────────────────────────────────

    repoSettings: () =>
      run(cmds.repoSettingsCmd(forge), (stdout) => {
        if (forge === "github") return mapGhRepo(asRecord(stdout));
        return mapGlRepo(asRecord(stdout));
      }),
  };
}

/** Extract the owner (first path segment) from a remote URL. */
export function parseOwner(url: string): string | undefined {
  const m = url.replace(/\.git$/i, "").match(/\/([^/]+)\/([^/]+)$/);
  return m?.[1];
}

/** Extract the repo (last path segment) from a remote URL. */
export function parseRepo(url: string): string | undefined {
  const m = url.replace(/\.git$/i, "").match(/\/([^/]+)\/([^/]+)$/);
  return m?.[2];
}

// Re-export the sub-module pieces so callers can reach them from forge.ts
// without a second import path (S4 imports from "./forge.ts" only).
export {
  ForgeFieldError,
  mapGhIssue,
  mapGhIssueWithNumber,
  mapGhPr,
  mapGhPrWithNumber,
  mapGhRepo,
  mapGhRun,
  mapGlIssue,
  mapGlMr,
  mapGlPipeline,
  mapGlPipelineJobs,
  mapGlRepo,
} from "./forge-mapping.ts";
export { checkGitlabReadiness, checkGithubReadiness, composeGlReadiness } from "./forge-merge.ts";
export type {
  MergeReadiness,
  MergeReadinessResult,
  NormalizedCICheck,
  NormalizedCIRun,
  NormalizedComment,
  NormalizedIssue,
  NormalizedLabel,
  NormalizedPullRequest,
  NormalizedRepo,
} from "./forge-types.ts";
export * as forgeCommands from "./forge-commands.ts";
export type { ForgeType, ForgeDetection } from "./forge-detect.ts";
export { GL_TERMINAL_CI, GH_TERMINAL_CI, terminalCiFor } from "./forge-ci-terminal.ts";
