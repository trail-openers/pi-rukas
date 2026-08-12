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
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
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
      `pi-ensemble: /work driver running for issue #${soleIssue}${restartTag}. State in .pi/work-state/${soleIssue}.json — inspect it any time with /work-status.`,
    );
    void (async () => {
      try {
        await runWorkDriver({ pi, repoRoot, issue: soleIssue, restart, mergeGrant });
      } catch (err) {
        trace(`work-driver: unexpected throw for #${soleIssue}: ${(err as Error).message}`);
        try {
          notifyAgent(
            pi,
            `pi-ensemble: /work driver crashed on issue #${soleIssue}: ${(err as Error).message}. Inspect .pi/work-state/${soleIssue}.json (or run /work-status ${soleIssue}). The cycle's own state is intact — your git work is untouched.`,
          );
        } catch {
          /* nothing we can do */
        }
      }
    })();
    return { mode: "single", issues: [soleIssue] };
  }

  // Multi-issue path — analyze + group + iterate, all in the background.
  sink.notify(
    `pi-ensemble: analyzing ${issues.length} issues (#${issues.join(", #")}) for grouping…`,
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
        `pi-ensemble: /work grouping decided K=${groupList.length} group(s) — ${summary}${notesLine}\n${resolvedParallelGroups() > 1 ? `Running up to ${concurrency} cycle(s) concurrently` : "Running cycles sequentially"}${restartTag}; a failed group parks and the queue continues.`,
      );
    } catch {
      /* nothing we can do */
    }

    // #368 — park-and-continue. A group that ends non-merged is recorded with
    // its reason and the queue moves on; only a systemic failure (spend cap,
    // quota window, driver throw) stops everything, because only those make
    // the next group's attempt pointless. Pre-#368 any failure halted, which
    // is how one 429 left 11 unrelated issues unstarted.
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
    try {
      notifyAgent(pi, renderQueueSummary(summaryResult));
    } catch {
      /* nothing we can do */
    }
  })();
  return { mode: "grouped", issues };
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
