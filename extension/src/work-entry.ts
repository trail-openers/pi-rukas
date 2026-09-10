/**
 * work-entry — starting a `/work` cycle, independent of who asked.
 *
 * Extracted from `commands.ts` so a tool can start a cycle the same way the
 * slash command does. A PM once hit a wall it could not get past (it had
 * killed a cycle over `needs-human-attention` labels and had no way to
 * restart one) and reimplemented the driver by hand — no state file, no
 * queue, no handoff artifact, no branch the driver knew about. The fix is
 * giving PM the real thing to call.
 *
 * `--merge` does NOT live here: it is the only `AuthoritySource` that bypasses
 * the #406/#407 policy judge; an LLM-settable boolean there is a cycle granting
 * itself merge authority.
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyAgent } from "./agent-message.ts";
import { setJobIssues } from "./async-jobs-registry.ts";
import { startJob } from "./async-jobs.ts";
import { detectForge } from "./forge-detect.ts";
import { type Forge, createForge } from "./forge.ts";
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
        "pi-rukas: /work needs at least one issue number (e.g., /work 547, or /work 561 562 to analyze + group multi-issue).",
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
 *
 * #676 — the grouping pass (fetch bodies → groupIssues) now happens BEFORE
 * the group-result notification, so both entry paths (slash command via
 * launchWork, PM tool via runDriver) emit the SAME accurate
 * `K=<actual group count> group(s) — <summary>` + `rules fired:` message
 * instead of one path emitting a pre-grouping placeholder that names neither
 * the actual group count nor the rules that fired. `concurrency` is derived
 * from the ACTUAL group count, not the raw issue count.
 *
 * `notify` is the caller-provided delivery function for the grouping-decided
 * line (the slash-command path pipes it through notifyAgent; the tool path
 * pipes it through its sink). `concurrency` is no longer a parameter — it is
 * derived internally from `groupList.length` and `resolvedParallelGroups()`,
 * so both entry paths share one correct value.
 */
export async function runGroupedIssues(
  pi: ExtensionAPI,
  repoRoot: string,
  issues: number[],
  restart: boolean,
  mergeGrant: boolean,
  notify: (text: string) => void,
): Promise<string> {
  const bodiesByIssue = await fetchIssueBodies(repoRoot, issues);
  const { groups, notes } = groupIssues(issues, bodiesByIssue);
  const groupList = Object.values(groups);
  // #676 lens-findings — the summary and per-issue rule notes are built from
  // issue titles/bodies (untrusted content) and land in the agent prompt
  // channel via notify/notifyAgent, which — unlike the #388 notify hook
  // (stdin only) — has no bound. Cap each so a pathological title or a very
  // large grouped invocation cannot bloat the PM session or shape
  // prompt-injection text into the driver-event stream. A cut group keeps its
  // id (that is the operator's lookup key); a cut notes list gets an ellipsis
  // naming the count of the notes dropped.
  const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const groupBits = groupList.map((g) => cut(`${g.id}: #${g.issues.join(", #")}`, 120));
  const summary = cut(groupBits.join(" | "), 2000);
  const notesLine =
    notes.length > 0
      ? `\n  rules fired: ${notes.length > 4 ? `${cut(notes.slice(0, 4).join("; "), 800)} (+${notes.length - 4} more)` : cut(notes.join("; "), 800)}`
      : "";
  const concurrency = Math.min(resolvedParallelGroups(), groupList.length);
  const restartTag = restart ? " (restart — prior state wiped)" : "";
  notify(
    `pi-rukas:driver-event v1 kind=group-result issue=${issues.join(", ")} at=${new Date().toISOString()}\npi-rukas: /work grouping decided K=${groupList.length} group(s) — ${summary}${notesLine}\n${resolvedParallelGroups() > 1 ? `Running up to ${concurrency} cycle(s) concurrently` : "Running cycles sequentially"}${restartTag}; a failed group parks and the queue continues.`,
  );

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
      // #676 — hold the runWorkQueue worker slot (and the inFlight entry the
      // pre-dispatch overlap gate keys on) until the driver reaches a terminal
      // state. startJob is fire-and-forget; without this await, runGroup would
      // resolve within the same event-loop tick and the gate's inFlight map
      // would be empty by the time the next worker checks it, making the
      // pre-dispatch serialization a no-op on the real entry path.
      await handle.completion;
      return { started: true };
    },
  });
  return renderQueueSummary(summaryResult);
}

/**
 * Forge adapter for the /work entry path (#612 S4 task-b). The entry path
 * never ran through a driver cycle, so no `Forge` exists to reuse — build
 * one from S1's detection. `PI_ENSEMBLE_FORGE=none` (and any unresolvable
 * repo) refuses the forge path; callers fall back to raw `gh` exec.
 */
export async function entryForge(repoRoot: string): Promise<Forge | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  try {
    const det = await detectForge(repoRoot, {});
    if (det.forge === "unknown") {
      trace(`work-entry: forge unknown (source=${det.source}) — raw-gh path`);
      return undefined;
    }
    return createForge(det, { cwd: repoRoot });
  } catch (err) {
    trace(`work-entry: forge detection failed: ${(err as Error).message} — raw-gh path`);
    return undefined;
  }
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
      `pi-rukas:driver-event v1 kind=work-start issue=${soleIssue} at=${new Date().toISOString()}\npi-rukas: /work driver running for issue #${soleIssue}${restartTag}. State in .pi/work-state/${soleIssue}.json — inspect it any time with /work-status.`,
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
              `pi-rukas:driver-event v1 kind=crash issue=${soleIssue} at=${new Date().toISOString()}\npi-rukas: /work driver crashed on issue #${soleIssue}: ${(err as Error).message}. Inspect .pi/work-state/${soleIssue}.json (or run /work-status ${soleIssue}). The cycle's own state is intact — your git work is untouched.`,
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
    `pi-rukas:driver-event v1 kind=group-start issue=${issues.join(", ")} at=${new Date().toISOString()}\npi-rukas: analyzing ${issues.length} issues (#${issues.join(", #")}) for grouping…`,
  );
  void (async () => {
    const notify: (text: string) => void = (text) => {
      try {
        notifyAgent(pi, text);
      } catch {
        /* nothing we can do */
      }
    };
    const summaryResult = await runGroupedIssues(pi, repoRoot, issues, restart, mergeGrant, notify);
    // Best-effort end-of-queue summary delivery — a notification failure must
    // not turn a completed queue into an error.
    try {
      notifyAgent(pi, summaryResult);
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
      `pi-rukas:driver-event v1 kind=work-start issue=${soleIssue} at=${new Date().toISOString()}\npi-rukas: /work driver running for issue #${soleIssue}${restartTag}. State in .pi/work-state/${soleIssue}.json — inspect it any time with /work-status.`,
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
    `pi-rukas:driver-event v1 kind=group-start issue=${issues.join(", ")} at=${new Date().toISOString()}\npi-rukas: analyzing ${issues.length} issues (#${issues.join(", #")}) for grouping…`,
  );
  const summary = `work-driver (grouped) for ${issues.length} issues (repoRoot=${repoRoot})`;
  trace(`/work (grouped) → ${summary}`);

  try {
    const summaryResult = await runGroupedIssues(pi, repoRoot, issues, restart, mergeGrant, (t) => {
      void notifyAgent(pi, t);
    });
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
 * Fetch each issue body for the grouping pass, in parallel.
 *
 * The grouping rules read the body for link markers, file paths and subsystem
 * tags. An issue whose fetch fails gets an empty body, which drops it to R5
 * (its own group) rather than removing it from grouping entirely.
 *
 * #612 S4 task-b — the gh call is now routed through the forge adapter
 * (`forge.issueView`). A forge that cannot be resolved falls back to the
 * pre-migration raw-`gh` exec so the entry path works on every repo shape.
 */
export async function fetchIssueBodies(
  repoRoot: string,
  issues: number[],
  forge?: Forge,
): Promise<Record<number, string>> {
  const resolved = forge ?? (await entryForge(repoRoot));
  const fetches = await Promise.allSettled(
    issues.map(async (n) => {
      if (!resolved) return "";
      // S2's adapter: the grouping rules read `.body` via the normalized
      // field; the title is kept for R4. The adapter's `issueView` command
      // requests the fields its mapper requires (number+state, plus the
      // title/body/labels the grouping rules read).
      const issue = await resolved.issueView(n);
      return `title: ${issue.title}\n${issue.body}`;
    }),
  );
  const bodies: Record<number, string> = {};
  issues.forEach((n, i) => {
    const r = fetches[i];
    if (n !== undefined) bodies[n] = r?.status === "fulfilled" ? r.value : "";
  });
  return bodies;
}
