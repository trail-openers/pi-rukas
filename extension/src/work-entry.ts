/**
 * work-entry — starting a `/work` cycle, independent of who asked.
 *
 * Extracted from `commands.ts` so a tool can start a cycle the same way the
 * slash command does. The motivating incident: a PM hit a wall it could not get
 * past — it had killed a cycle over `needs-human-attention` labels and had no
 * way to restart one — so it reimplemented the driver by hand. No state file,
 * no queue, no handoff artifact, no review-cap timer, and a branch the driver
 * knew nothing about. Everything the compiled pipeline exists to guarantee was
 * silently absent, and nothing in the transcript said so.
 *
 * The fix is not more doctrine telling PM not to do that. It is giving PM the
 * real thing to call.
 *
 * What deliberately does NOT live here: `--merge`. It is one of two
 * `AuthoritySource`s and the only one that bypasses the #406/#407 policy judge.
 * An LLM-settable boolean there is a cycle granting itself merge authority, so
 * the tool has no such parameter and `launchWork` takes the grant as an
 * explicit argument that only the command path supplies.
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyAgent } from "./agent-message.ts";
import { setJobIssues } from "./async-jobs-registry.ts";
import { startJob } from "./async-jobs.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { groupIssues, resolvedParallelGroups } from "./work-driver-grouping.ts";
import { runWorkDriver } from "./work-driver.ts";
import { renderQueueSummary, runWorkQueue } from "./work-queue.ts";

const execp = promisify(exec);

export interface WorkInvocation {
  issues: number[];
  restart: boolean;
  /** Operator-only. Never settable from a tool — see the module docstring. */
  mergeGrant: boolean;
}

/**
 * Parse `/work` arguments.
 *
 * Returns an `error` string rather than throwing, so both the command and the
 * tool can render it in their own idiom.
 */
export function parseWorkArgs(args: string): WorkInvocation | { error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const issues = tokens
    .filter((t) => !t.startsWith("--"))
    .map((t) => Number.parseInt(t, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (issues.length === 0) {
    return {
      error:
        "pi-ensemble: /work needs at least one issue number (e.g., /work 547, or /work 561 562 to analyze + group multi-issue).",
    };
  }
  return {
    issues,
    restart: tokens.includes("--restart"),
    // #380 — the operator's grant of merge authority for this run. The only
    // other source is an explicit grant in the project's AGENTS.md; with
    // neither, cycles open their PR and park.
    mergeGrant: tokens.includes("--merge"),
  };
}

/**
 * Resolve the repository root for a session directory.
 *
 * Callers pass `ctx.cwd` (the session's directory, first-class Pi API), never
 * `process.cwd()` — those diverge whenever Pi was launched from elsewhere, and
 * the divergence silently retargets the state file at the wrong repo (#360).
 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execp("git rev-parse --show-toplevel", { cwd });
    return stdout.trim();
  } catch {
    return cwd;
  }
}

/**
 * Where a launch's immediate, human-facing lines go.
 *
 * The command path paints them as TUI toasts; the tool path returns them as its
 * result, which is strictly better there — the calling agent actually reads a
 * tool result, and never sees a toast.
 */
export interface WorkLaunchSink {
  notify(text: string): void;
}

export interface WorkLaunch {
  mode: "single" | "grouped";
  issues: number[];
}

/**
 * Shared single-issue driver runner. Used by both launchWork (fire-and-forget
 * via startJob) and runDriver (await + DispatchResult).
 *
 * #593 lens-findings #5/#6 — extracted to eliminate duplication between
 * launchWork and runDriver's single-issue branches.
 */
function runSingleIssue(
  pi: ExtensionAPI,
  repoRoot: string,
  issue: number,
  restart: boolean,
  mergeGrant: boolean,
): Promise<import("./work-driver.ts").DriverOutcome> {
  return runWorkDriver({ pi, repoRoot, issue, restart, mergeGrant });
}

/**
 * Shared multi-issue driver runner: grouping pass + work queue.
 *
 * #593 lens-findings #5/#6 — extracted to eliminate duplication between
 * launchWork and runDriver's multi-issue branches.
 */
async function runGroupedIssues(
  pi: ExtensionAPI,
  repoRoot: string,
  issues: number[],
  restart: boolean,
  mergeGrant: boolean,
  concurrency: number,
): Promise<string> {
  const bodiesByIssue = await fetchIssueBodies(repoRoot, issues);
  const { groups, notes } = groupIssues(issues, bodiesByIssue);
  const groupList = Object.values(groups);
  const summary = groupList.map((g) => `${g.id}: #${g.issues.join(", #")}`).join(" | ");
  const notesLine = notes.length > 0 ? `\n  rules fired: ${notes.join("; ")}` : "";

  const summaryResult = await runWorkQueue({
    repoRoot,
    groups: groupList,
    restart,
    concurrency,
    runGroup: (primary, groupIssueNums) =>
      runWorkDriver({
        pi,
        repoRoot,
        issue: primary,
        issues: groupIssueNums,
        restart,
        mergeGrant,
        parallelCycles: concurrency,
      }),
  });
  return renderQueueSummary(summaryResult);
}

/**
 * Start a cycle (or a grouped queue of them) and return immediately.
 *
 * Fire-and-forget by design: grouping analysis plus K cycles run for a long
 * time, and the caller — a slash command handler or a tool — must not block on
 * them. Progress arrives via `notifyAgent`, outcomes via `/work-status`.
 */
export async function launchWork(
  pi: ExtensionAPI,
  opts: {
    repoRoot: string;
    invocation: WorkInvocation;
    sink: WorkLaunchSink;
  },
): Promise<WorkLaunch> {
  const { repoRoot, invocation, sink } = opts;
  const { issues, restart, mergeGrant } = invocation;
  const restartTag = restart ? " (restart — prior state wiped)" : "";

  trace(
    `/work → driver loop for ${issues.length === 1 ? `issue #${issues[0]}` : `${issues.length} issues (#${issues.join(", #")})`}${restartTag} (repoRoot=${repoRoot})`,
  );

  // Single-issue path — no grouping needed.
  if (issues.length === 1) {
    const soleIssue = issues[0];
    if (soleIssue === undefined) return { mode: "single", issues: [] };
    sink.notify(
      `pi-ensemble:driver-event v1 kind=work-start issue=${soleIssue} at=${new Date().toISOString()}\npi-ensemble: /work driver running for issue #${soleIssue}${restartTag}. State in .pi/work-state/${soleIssue}.json — inspect it any time with /work-status.`,
    );
    // Register this cycle in the job registry so /work-status <jobId> can
    // resolve it back to its issue number(s). #591 fix — the tool path
    // (start_work_driver) called setJobIssues but the slash-command path
    // did not, making /work-status <jobId> silently fail for the majority
    // of real-world uses (slash commands, not tools).
    const handle = startJob(pi, {
      label: "work-driver",
      role: "work-driver",
      skipDeck: true,
      ownerKind: "driver" as const,
      work: async () => {
        try {
          await runSingleIssue(pi, repoRoot, soleIssue, restart, mergeGrant);
          return makeResult(true, `Completed issue #${soleIssue}${restartTag}`, Date.now());
        } catch (err) {
          trace(`work-driver: unexpected throw for #${soleIssue}: ${(err as Error).message}`);
          try {
            await notifyAgent(
              pi,
              `pi-ensemble:driver-event v1 kind=crash issue=${soleIssue} at=${new Date().toISOString()}\npi-ensemble: /work driver crashed on issue #${soleIssue}: ${(err as Error).message}. Inspect .pi/work-state/${soleIssue}.json (or run /work-status ${soleIssue}). The cycle's own state is intact — your git work is untouched.`,
            );
          } catch {
            /* nothing we can do */
          }
          return makeResult(
            false,
            `/work driver crashed on issue #${soleIssue}: ${(err as Error).message} — state intact in .pi/work-state/${soleIssue}.json`,
            Date.now(),
            (err as Error).message,
          );
        }
      },
    });
    setJobIssues(handle.jobId, [soleIssue]);
    // Fire-and-forget: ignore completion (the steer report goes to PM for
    // pm-owned jobs; we skip that here via ownerKind="driver" so it lands
    // via the state file + notifyAgent instead).
    handle.completion.catch(() => {
      /* driver-owned: already handled inside */
    });
    return { mode: "single", issues: [soleIssue] };
  }

  // Multi-issue path — analyze + group + iterate, all in the background.
  sink.notify(
    `pi-ensemble:driver-event v1 kind=group-start issue=${issues.join(", ")} at=${new Date().toISOString()}\npi-ensemble: analyzing ${issues.length} issues (#${issues.join(", #")}) for grouping…`,
  );
  void (async () => {
    const bodiesByIssue = await fetchIssueBodies(repoRoot, issues);
    const { groups, notes } = groupIssues(issues, bodiesByIssue);
    const groupList = Object.values(groups);
    const summary = groupList.map((g) => `${g.id}: #${g.issues.join(", #")}`).join(" | ");
    const notesLine = notes.length > 0 ? `\n  rules fired: ${notes.join("; ")}` : "";
    const concurrency = Math.min(resolvedParallelGroups(), groupList.length);
    try {
      notifyAgent(
        pi,
        `pi-ensemble:driver-event v1 kind=group-result issue=${issues.join(", ")} at=${new Date().toISOString()}\npi-ensemble: /work grouping decided K=${groupList.length} group(s) — ${summary}${notesLine}\n${resolvedParallelGroups() > 1 ? `Running up to ${concurrency} cycle(s) concurrently` : "Running cycles sequentially"}${restartTag}; a failed group parks and the queue continues.`,
      );
    } catch {
      /* nothing we can do */
    }

    // #368 — park-and-continue. A group that ends non-merged is recorded with
    // its reason and the queue moves on; only a systemic failure stops
    // everything, because only those make the next group's attempt pointless.
    // Pre-#368 any failure halted, which is how one 429 left 11 unrelated
    // issues unstarted.
    //
    // Each group cycle registers a job entry via startJob so /work-status
    // <jobId> can resolve it back to its issue numbers (#591 fix).
    // The startJob work function runs runWorkDriver; the callback returns
    // immediately so runWorkQueue's concurrency batching still works.
    const completionPromises: Promise<unknown>[] = [];
    const summaryResult = await runWorkQueue({
      repoRoot,
      groups: groupList,
      restart,
      concurrency,
      runGroup: async (primary, groupIssueNums) => {
        const handle = startJob(pi, {
          label: `work-driver-group:${groupList.find((g) => g.issues[0] === primary)?.id ?? "unknown"}`,
          role: "work-driver",
          skipDeck: true,
          ownerKind: "driver" as const,
          work: async () => {
            await runWorkDriver({
              pi,
              repoRoot,
              issue: primary,
              issues: groupIssueNums,
              restart,
              mergeGrant,
              parallelCycles: concurrency,
            });
            return makeResult(
              true,
              `Completed group: #${(groupIssueNums ?? [primary]).join(", #")}`,
              Date.now(),
            );
          },
        });
        setJobIssues(handle.jobId, groupIssueNums ?? [primary]);
        completionPromises.push(handle.completion);
        // Return immediately — the actual work runs in the background
        // via the startJob work function. runWorkQueue's concurrency
        // batching controls when these fire.
        return { started: true };
      },
    });
    // Wait for all group cycles to complete.
    await Promise.all(completionPromises);
    try {
      notifyAgent(
        pi,
        `pi-ensemble:driver-event v1 kind=queue-summary issue=${issues.join(", ")} at=${new Date().toISOString()}\n${renderQueueSummary(summaryResult)}`,
      );
    } catch {
      /* nothing we can do */
    }
  })();
  return { mode: "grouped", issues };
}

// ---------------------------------------------------------------------------
// workDriver — in-process work function for startJob (tool path).
//
// Wraps the same driver logic that launchWork fire-and-forgets into a
// return-typed function so startJob can await it, deliver a structured
// steer on completion, and produce a DispatchResult for async-jobs.
// ---------------------------------------------------------------------------

/** Build a DispatchResult for a work-driver outcome.
 *
 * The work-driver is an in-process, non-LLM cycle — it does not spawn agents,
 * so toolUses is always empty, usage is always zero, and there is no
 * transcript. These fields are structurally meaningless for this consumer
 * (the `dispatch-completed` event carries the real timing via `e.ms`).
 *
 * `transcriptPath` is `undefined` deliberately — there is no transcript to
 * read. Fake paths were confusing downstream consumers that tried to
 * dereference them.
 */
function makeResult(ok: boolean, text: string, startMs: number, error?: string): DispatchResult {
  return {
    role: "work-driver",
    ok,
    text,
    toolUses: [],
    ms: Date.now() - startMs,
    exitCode: ok ? 0 : 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    transcriptPath: undefined,
    errorStop: error ? { reason: "work-driver-threw", message: error } : undefined,
  };
}

/**
 * Run the work driver to completion and return a DispatchResult.
 *
 * This is the work function consumed by `startJob` in the tool path. It
 * reuses the same logic as launchWork's background IIFE but awaits the
 * driver instead of fire-and-forgetting, so startJob can deliver a
 * structured steer report on completion.
 */
export async function runDriver(
  pi: ExtensionAPI,
  opts: {
    repoRoot: string;
    invocation: WorkInvocation;
    sink: WorkLaunchSink;
  },
): Promise<DispatchResult> {
  const { repoRoot, invocation, sink } = opts;
  const { issues, restart, mergeGrant } = invocation;
  const restartTag = restart ? " (restart — prior state wiped)" : "";
  const startMs = Date.now();

  // Single-issue path — no grouping needed.
  if (issues.length === 1) {
    const soleIssue = issues[0];
    if (soleIssue === undefined) {
      return makeResult(false, "No issues to process.", startMs);
    }
    sink.notify(
      `pi-ensemble:driver-event v1 kind=work-start issue=${soleIssue} at=${new Date().toISOString()}\npi-ensemble: /work driver running for issue #${soleIssue}${restartTag}. State in .pi/work-state/${soleIssue}.json — inspect it any time with /work-status.`,
    );
    try {
      await runSingleIssue(pi, repoRoot, soleIssue, restart, mergeGrant);
      return makeResult(
        true,
        `Completed issue #${soleIssue}${restartTag}. State in .pi/work-state/${soleIssue}.json`,
        startMs,
      );
    } catch (err) {
      trace(`work-driver: unexpected throw for #${soleIssue}: ${(err as Error).message}`);
      return makeResult(
        false,
        `/work driver crashed on issue #${soleIssue}: ${(err as Error).message} — state intact in .pi/work-state/${soleIssue}.json`,
        startMs,
        (err as Error).message,
      );
    }
  }

  // Multi-issue path — analyze + group + iterate.
  sink.notify(
    `pi-ensemble:driver-event v1 kind=group-start issue=${issues.join(", ")} at=${new Date().toISOString()}\npi-ensemble: analyzing ${issues.length} issues (#${issues.join(", #")}) for grouping…`,
  );
  const concurrency = Math.min(resolvedParallelGroups(), issues.length);
  const summary = `work-driver (grouped) for ${issues.length} issues (repoRoot=${repoRoot})`;
  trace(`/work (grouped) → ${summary}`);

  try {
    await notifyAgent(
      pi,
      `pi-ensemble:driver-event v1 kind=group-result issue=${issues.join(", ")} at=${new Date().toISOString()}\npi-ensemble: /work grouping decided K=grouped ${issues.length} issue(s)\n${resolvedParallelGroups() > 1 ? `Running up to ${concurrency} cycle(s) concurrently` : "Running cycles sequentially"}${restartTag}; a failed group parks and the queue continues.`,
    );
  } catch {
    /* nothing we can do */
  }

  try {
    const summaryResult = await runGroupedIssues(
      pi,
      repoRoot,
      issues,
      restart,
      mergeGrant,
      concurrency,
    );
    return makeResult(true, summaryResult, startMs);
  } catch (err) {
    trace(`work-driver (grouped): unexpected throw: ${(err as Error).message}`);
    return makeResult(
      false,
      `/work driver crashed (grouped): ${(err as Error).message}`,
      startMs,
      (err as Error).message,
    );
  }
}

/**
 * Fetch each issue body via `gh issue view`, in parallel.
 *
 * The grouping rules read the body for link markers, file paths and subsystem
 * tags. An issue whose fetch fails gets an empty body, which drops it to R5
 * (its own group) rather than removing it from grouping entirely.
 */
async function fetchIssueBodies(
  repoRoot: string,
  issues: number[],
): Promise<Record<number, string>> {
  const fetches = await Promise.allSettled(
    issues.map(async (n) => {
      const { stdout } = await execp(`gh issue view ${n} --json title,body,labels`, {
        cwd: repoRoot,
        maxBuffer: 2 * 1024 * 1024,
      });
      // #376 — parse out `.body`. The raw `--json` stdout is ONE line of
      // compact JSON with `\n` as two-character escapes, so every `^`-anchored
      // rule (R3 split markers, R4 subsystem tags) could only ever see
      // `{"body":"` as its line start and never fired. Title is kept for R4.
      try {
        const parsed = JSON.parse(stdout) as { title?: string; body?: string };
        return `title: ${parsed.title ?? ""}\n${parsed.body ?? ""}`;
      } catch {
        // Unparseable — fall back to the raw text rather than dropping it.
        return stdout;
      }
    }),
  );
  const bodies: Record<number, string> = {};
  for (let i = 0; i < issues.length; i++) {
    const n = issues[i];
    if (n === undefined) continue;
    const r = fetches[i];
    bodies[n] = r?.status === "fulfilled" ? r.value : "";
  }
  return bodies;
}
