/**
 * forge — unified GitHub (gh) / GitLab (glab) adapter (S2 of epic #608).
 *
 * Normalizes field names, states, and CLI shapes behind one TypeScript API.
 * S1's `detectForge` decides the forge; this module does the work against it.
 *
 * Sub-modules: `forge-types.ts` (types), `forge-commands.ts` (cmd builders),
 * `forge-mapping.ts` (JSON mappers), `forge-merge.ts` (merge readiness).
 */

import { exec } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as cmds from "./forge-commands.ts";
import type { ForgeDetection, ForgeType } from "./forge-detect.ts";
import {
  ForgeFieldError,
  asArray,
  asRecord,
  makeMinimalPr,
  mapGhChecks,
  mapGhIssue,
  mapGhIssueLabel,
  mapGhIssueWithNumber,
  mapGhPr,
  mapGhPrWithNumber,
  mapGhRepo,
  mapGhRun,
  mapGlIssue,
  mapGlIssueLabel,
  mapGlMr,
  mapGlPipeline,
  mapGlPipelineJobs,
  mapGlRepo,
  parsePlainTextIssue,
  parsePlainTextPr,
  parsePrNumberFromResponse,
} from "./forge-mapping.ts";
import { checkGithubReadiness, checkGitlabReadiness, composeGlReadiness } from "./forge-merge.ts";
import type {
  MergeReadiness,
  MergeReadinessResult,
  NormalizedCICheck,
  NormalizedCIRun,
  NormalizedIssue,
  NormalizedLabel,
  NormalizedPullRequest,
  NormalizedRepo,
} from "./forge-types.ts";

const execp = promisify(exec);

/** The exec seam — same shape as the driver's `VerifyExecFn`. */
export type ForgeExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string },
) => Promise<{ stdout: string; stderr?: string }>;

export interface Forge {
  /** The resolved forge type (`unknown` → every operation rejects). */
  forge: ForgeType;
  /** The resolved host (from S1). */
  host: string | undefined;
  /** The owner (first path segment of the remote URL). */
  owner: string;
  /** The repo (last path segment of the remote URL). */
  repo: string;
  /** The repo root the commands run in. */
  cwd: string;

  // Issues
  issueView(number: number): Promise<NormalizedIssue>;
  issueCreate(title: string, body: string): Promise<NormalizedIssue>;
  issueEdit(number: number, body: string): Promise<NormalizedIssue>;
  issueComment(number: number, body: string): Promise<string>;
  issueSearch(query: string): Promise<NormalizedIssue[]>;

  // Pull requests / MRs
  prView(number: number): Promise<NormalizedPullRequest>;
  prList(opts?: { state?: string; sourceBranch?: string }): Promise<NormalizedPullRequest[]>;
  prCreate(
    title: string,
    headBranch: string,
    body: string,
    baseBranch?: string,
  ): Promise<NormalizedPullRequest>;
  prMerge(number: number, method?: "squash" | "merge" | "rebase"): Promise<string>;
  prDiff(number: number): Promise<string>;
  prChecks(number: number): Promise<NormalizedCICheck[]>;

  // CI
  ciWatch(runId: number, opts?: CiWatchOpts): Promise<CiWatchResult>;
  ciRun(id: number): Promise<NormalizedCIRun>;

  // Merge readiness (SAFETY-CRITICAL)
  mergeReadiness(number: number, opts?: { maxBuffer?: number }): Promise<MergeReadinessResult>;

  // Labels
  labelCreate(name: string, color: string): Promise<NormalizedLabel | undefined>;
  labelAdd(target: "issue" | "mr", number: number, name: string): Promise<void>;
  labelRemove(target: "issue" | "mr", number: number, name: string): Promise<void>;

  // Repo settings
  repoSettings(): Promise<NormalizedRepo>;
}

// ── Terminal CI statuses ──────────────────────────────────────────────────

/**
 * Terminal statuses for CI-watch, normalized to uppercase.
 *
 * - GitHub Actions run conclusions (uppercase after mapping): SUCCESS,
 *   FAILURE, CANCELED, NEUTRAL, SKIPPED, TIMED_OUT, STOPPED.
 * - GitLab pipeline terminal statuses (per the epic spec): SUCCESS, FAILED,
 *   CANCELED, SKIPPED, MANUAL. (GitLab's `manual` is terminal because the
 *   pipeline is waiting for a human trigger, not a bot.)
 *
 * The watch loop polls until the run/pipeline status lands in this set, or
 * the 30-minute cap fires.
 */
export const GH_TERMINAL_CI: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILURE",
  "CANCELED",
  "CANCELLED",
  "NEUTRAL",
  "SKIPPED",
  "TIMED_OUT",
  "STOPPED",
]);

export const GL_TERMINAL_CI: ReadonlySet<string> = new Set([
  "SUCCESS",
  "FAILED",
  "CANCELED",
  "SKIPPED",
  "MANUAL",
]);

export function terminalCiFor(forge: ForgeType): ReadonlySet<string> {
  return forge === "gitlab" ? GL_TERMINAL_CI : GH_TERMINAL_CI;
}

export interface CiWatchOpts {
  /** Poll interval in ms (default 30_000). */
  pollMs?: number;
  /** Overall timeout in ms (default 30 min = 1_800_000). */
  timeoutMs?: number;
  /** Injectable clock (default `Date.now`). For tests. */
  now?: () => number;
  /** Injectable sleep (default `setTimeout`-based). For tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type CiWatchResult =
  | { ok: true; run: NormalizedCIRun; terminal: boolean; timedOut: false }
  | { ok: true; run: NormalizedCIRun | undefined; terminal: false; timedOut: true };

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// ── The Forge object ─────────────────────────────────────────────────────

export interface CreateForgeOpts {
  /** The exec seam (default `promisify(exec)`). */
  execFn?: ForgeExecFn;
  /** The repo root (default `process.cwd()`). */
  cwd?: string;
  /**
   * Per-call executor options merged into every adapter exec (S4 driver
   * sites use this to carry their per-attempt deadline, e.g. the explore
   * issue-body fetch's 45s timeout). `cwd` is always the forge's repo root.
   */
  execOpts?: { timeout?: number; maxBuffer?: number };
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

  const run = async <T>(cmd: string, map: (stdout: string) => T): Promise<T> => {
    const { stdout } = await execFn(cmd, { cwd, maxBuffer: 512 * 1024, ...extraOpts });
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

    issueCreate: (title, body) =>
      withBodyFile(`create-${title.slice(0, 16)}`, body, (file) =>
        run(cmds.issueCreateCmd(forge, title, file), (stdout) => {
          if (forge === "github") return mapGhIssue(asRecord(stdout));
          return mapGlIssue(asRecord(stdout));
        }),
      ),

    issueEdit: (number, body) =>
      withBodyFile(`edit-${number}`, body, (file) =>
        run(cmds.issueEditCmd(forge, number, file), (stdout) => {
          if (forge === "github") return mapGhIssue(asRecord(stdout));
          return mapGlIssue(asRecord(stdout));
        }),
      ),

    issueComment: (number, body) =>
      withBodyFile(`comment-${number}`, body, (file) =>
        run(cmds.issueCommentCmd(forge, number, file), (stdout) => stdout),
      ),

    issueSearch: (query) =>
      run(cmds.issueSearchCmd(forge, query), (stdout) => {
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

    prCreate: (title, headBranch, body, baseBranch) =>
      withBodyFile(`pr-${headBranch.slice(0, 16)}`, body, (file) =>
        run(cmds.prCreateCmd(forge, title, headBranch, file, baseBranch), (stdout) => {
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
      ),

    prMerge: (number, method = "squash") =>
      run(cmds.prMergeCmd(forge, number, method), (stdout) => stdout),

    prDiff: (number) => run(cmds.prDiffCmd(forge, number), (stdout) => stdout),

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

    ciWatch: async (runId, watchOpts) => {
      const pollMs = watchOpts?.pollMs ?? DEFAULT_POLL_MS;
      const timeoutMs = watchOpts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const now = watchOpts?.now ?? Date.now;
      const sleep =
        watchOpts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const start = now();
      const terminal = terminalCiFor(forge);

      let run: NormalizedCIRun | undefined;
      for (;;) {
        const stdout = await cmds.ciRunOnce(execFn, forge, cwd, owner, repo, runId);
        const o = JSON.parse(stdout) as Record<string, unknown>;
        run = forge === "github" ? mapGhRun(o) : mapGlPipeline(o);
        if (terminal.has(run.status)) {
          return { ok: true, run, terminal: true, timedOut: false };
        }
        if (now() - start >= timeoutMs) {
          return { ok: true, run, terminal: false, timedOut: true };
        }
        await sleep(pollMs);
      }
    },

    ciRun: (id) =>
      cmds.ciRunOnce(execFn, forge, cwd, owner, repo, id).then((stdout) => {
        const o = JSON.parse(stdout) as Record<string, unknown>;
        return forge === "github" ? mapGhRun(o) : mapGlPipeline(o);
      }),

    // ── Merge readiness (SAFETY-CRITICAL) ─────────────────────────────────

    mergeReadiness: (number, opts) => {
      if (forge === "github") return checkGithubReadiness(execFn, cwd, number, opts);
      return checkGitlabReadiness(execFn, cwd, number, opts);
    },

    // ── Labels ────────────────────────────────────────────────────────────

    labelCreate: (name, color) =>
      run(cmds.labelCreateCmd(forge, name, color), (stdout) => {
        if (!stdout || stdout === "" || stdout === "true") return undefined;
        try {
          const o = asRecord(stdout);
          if (forge === "github") return mapGhIssueLabel(o);
          return mapGlIssueLabel(o);
        } catch {
          return undefined;
        }
      }),

    labelAdd: (target, number, name) =>
      run(cmds.labelAddCmd(forge, target, number, name), () => undefined),

    labelRemove: (target, number, name) =>
      run(cmds.labelRemoveCmd(forge, target, number, name), () => undefined),

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
  NormalizedIssue,
  NormalizedLabel,
  NormalizedPullRequest,
  NormalizedRepo,
} from "./forge-types.ts";
export * as forgeCommands from "./forge-commands.ts";
export type { ForgeType, ForgeDetection } from "./forge-detect.ts";
