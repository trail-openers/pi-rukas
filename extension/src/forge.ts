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
import type { ForgeDetection, ForgeType } from "./forge-detect.ts";
import { type LabelListResult, labelOps } from "./forge-label-ops.ts";
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
import type { VisibilityFn } from "./public-hygiene-visibility.ts";
import { forgePublishRefusal } from "./work-driver-commit-hygiene.ts";
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
   * hook: every issue and PR write below goes through `run`, which is an
   * in-process exec, exactly like the #912 merge guard's mechanized merge, so
   * it never reaches a `tool_call`. Passing the text check through the same
   * pure matcher keeps the driver and the guard from disagreeing about what is
   * publishable, and the throw lands in the driver's existing error handling
   * (`plan-filing.ts`, `work-driver-commit.ts`), which already reports a failed
   * forge write.
   *
   * ASYNC, and on the SAME public-only rule the tool_call guard uses (#1788
   * round 2). The synchronous version of this check asked nothing about the
   * repository it was publishing to, so a downstream factory working in a
   * PRIVATE project had its PR bodies, comments and merge subjects refused on
   * the operator's private list — the friction that gets a guard switched off
   * for the repositories that do publish. This adapter knows its own owner,
   * repo and host, so it hands them to the one driver-side seam
   * (`driverPublicTextRefusal`), which resolves visibility the same way the
   * guard does: a POSITIVE private answer skips, and public, unknown or a
   * failed lookup all check.
   *
   * Checked BEFORE the command runs, so nothing is posted and then noticed.
   */
  const checkPublicText = async (label: string, text: string): Promise<void> => {
    await forgePublishRefusal(label, text, forgeCommand(label), {
      cwd,
      exec: (cmd, execOpts) => execFn(cmd, { ...execOpts, cwd }),
      visibility: opts.visibility,
      timeoutMs: extraOpts.timeout,
      // The adapter's own slug is the target: no command string has to be
      // parsed to work out which repository a `gh pr create` writes to when the
      // adapter was built from that repository's remote.
      target: owner !== "" && repo !== "" ? { owner, repo, host: det.host } : undefined,
    });
  };

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
   * nothing to publish, so it says so at the call site rather than leaving the
   * field out and letting the type decide what absent meant.
   */
  const NO_PUBLIC_TEXT_CHECK = async (): Promise<void> => {};

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
      // reaches the driver's existing forge-error handling.
      await checkPublicText("issue title", title);
      await checkPublicText("issue body", body);
      return withBodyFile(`create-${title.slice(0, 16)}`, body, (file) =>
        run(cmds.issueCreateCmd(forge, title, file, createOpts?.labels ?? []), (stdout) => {
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
      await checkPublicText("issue body", body);
      return withBodyFile(`edit-${number}`, body, (file) =>
        run(cmds.issueEditCmd(forge, number, file), (stdout) => {
          if (forge === "github") return mapGhIssue(asRecord(stdout));
          return mapGlIssue(asRecord(stdout));
        }),
      );
    },

    issueComment: async (number, body) => {
      await checkPublicText("issue comment", body);
      return withBodyFile(`comment-${number}`, body, (file) =>
        run(cmds.issueCommentCmd(forge, number, file), (stdout) => stdout),
      );
    },

    issueComments: (number) =>
      listIssueComments(
        { forge, run, withBodyFile, checkPublicText: NO_PUBLIC_TEXT_CHECK },
        number,
      ),

    issueSearch: (query, opts) =>
      run(cmds.issueSearchCmd(forge, query, opts), (stdout) => {
        const rows = asArray(stdout);
        return rows.map((raw) => {
          const o = raw as Record<string, unknown>;
          if (forge === "github") return mapGhIssue(o);
          return mapGlIssue(o);
        });
      }),

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

    prList: (opts) =>
      run(cmds.prListCmd(forge, opts), (stdout) => {
        // Tolerate both JSON arrays and a bare number (test fakes that
        // answer `gh pr list --json number --jq '.[0].number'`).
        const trimmed = stdout.trim();
        if (trimmed && !trimmed.startsWith("[") && !trimmed.startsWith("{")) {
          const n = Number.parseInt(trimmed, 10);
          if (Number.isFinite(n) && n > 0) {
            return [
              {
                number: n,
                url: "",
                state: "" as NormalizedPullRequest["state"],
                title: "",
                body: "",
                headRefName: undefined,
                baseRefName: undefined,
                author: undefined,
                mergeable: null,
                mergeStateStatus: null,
                labels: [],
                createdAt: undefined,
                updatedAt: undefined,
              },
            ];
          }
          return [];
        }
        const rows = asArray(stdout);
        return rows.map((raw) => {
          const o = raw as Record<string, unknown>;
          if (forge === "github") return mapGhPr(o);
          return mapGlMr(o);
        });
      }),

    prCreate: async (title, headBranch, body, opts) => {
      await checkPublicText("pull request title", title);
      await checkPublicText("pull request body", body);
      return withBodyFile(`pr-${headBranch.slice(0, 16)}`, body, (file) =>
        run(cmds.prCreateCmd(forge, title, headBranch, file, opts ?? {}), (stdout) => {
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

    prMerge: async (number, method: "squash" | "merge" | "rebase" = "squash", subject?: string) => {
      // #1788 — the squash subject a driver composes from the issue title is
      // published as the commit message on main, so it is a public text surface
      // like a title or a body, and it is checked before the merge runs. A
      // merge is the one forge write that cannot be undone from here.
      if (subject !== undefined) await checkPublicText("merge commit subject", subject);
      return run(cmds.prMergeCmd(forge, number, method, subject), (stdout) => stdout);
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
      return run(`glab api /projects/:id/pipelines/${latest.id}/jobs --output json`, (s) => {
        const parsed = JSON.parse(s || "[]");
        if (!Array.isArray(parsed)) throw new Error("forge: jobs not an array");
        return mapGlPipelineJobs(parsed);
      });
    },

    // ── CI ────────────────────────────────────────────────────────────────

    ciWatch: (runId, watchOpts) => ciWatchImpl(execFn, forge, cwd, owner, repo, runId, watchOpts),

    ciRun: (id) => ciRunImpl(execFn, forge, cwd, owner, repo, id),

    // ── Merge readiness (SAFETY-CRITICAL) ─────────────────────────────────

    mergeReadiness: (number, opts) => {
      if (forge === "github") return checkGithubReadiness(execFn, cwd, number, opts);
      return checkGitlabReadiness(execFn, cwd, number, opts);
    },

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
