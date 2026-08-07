/**
 * work-notify — the one place `/work` reaches a human who has walked away.
 *
 * `/work <issues>` is meant to be fire-and-forget, but when a cycle parked,
 * halted, or stopped awaiting a human merge, the only places that said so
 * were the Pi scrollback and a JSON file — both of which require you to
 * already be looking. `grep -rniE 'osascript|terminal-notifier|notify-send|
 * webhook|slack'` over `src/` returned nothing. The realistic sequence was:
 * fire over eight issues, go to lunch, come back two hours later to find it
 * stopped after twenty minutes on the second group.
 *
 * Three deliberate constraints:
 *
 *   1. **The transport is not our business.** The operator supplies a command
 *      (`PI_ENSEMBLE_NOTIFY_CMD`) and we run it — `osascript`,
 *      `terminal-notifier`, `notify-send`, `curl` to a webhook, `say`. Picking
 *      one for them means picking wrong for most of them.
 *   2. **Fail open, always.** A notification is an observer, and an observer
 *      that can break the thing it observes is worse than none. Every failure
 *      mode — missing binary, non-zero exit, a hook that hangs — is swallowed
 *      after a short timeout and recorded only in the trace.
 *   3. **Name the action, not the event.** "Issue #287 parked" is not
 *      actionable. "add acceptance criteria to #287" is. The queue already
 *      computes this in `humanActionFor`; the hook carries it rather than
 *      inventing its own wording.
 *
 * The message is passed on **stdin**, not interpolated into a shell line.
 * Issue titles and provider error text are untrusted input, and building a
 * command string out of them would be a shell-injection seam in a component
 * whose entire job is to be harmless.
 */

import { spawn } from "node:child_process";
import { trace } from "./trace.ts";

/** How long a hook may take before we stop caring. */
const NOTIFY_TIMEOUT_MS = 5_000;

/**
 * The operator's notification command, or undefined if they never set one.
 *
 * Unset is the default and means byte-identical behaviour to before this
 * module existed: nothing is spawned, nothing is attempted.
 */
export function notifyCommand(): string | undefined {
  const cmd = process.env.PI_ENSEMBLE_NOTIFY_CMD?.trim();
  return cmd ? cmd : undefined;
}

export type NotifyKind = "parked" | "halted" | "awaiting-merge" | "crashed";

export interface Notification {
  kind: NotifyKind;
  /** Issue numbers this concerns. */
  issues: number[];
  /** Why the cycle stopped — the operator's first question. */
  reason: string;
  /** What a human must do that the system cannot do itself. */
  action: string;
}

/**
 * The message a human actually reads, usually on a phone lock screen.
 *
 * One line for what happened, one for what to do. Anything longer is
 * truncated by every notification system there is, so length spent on
 * preamble is length taken from the action.
 */
export function formatNotification(n: Notification): string {
  const who = n.issues.length === 1 ? `#${n.issues[0]}` : `#${n.issues.join(", #")}`;
  const head: Record<NotifyKind, string> = {
    parked: `/work parked ${who}: ${n.reason}`,
    halted: `/work HALTED at ${who}: ${n.reason}`,
    "awaiting-merge": `/work finished ${who} — waiting on you to merge`,
    crashed: `/work crashed on ${who}: ${n.reason}`,
  };
  return `${head[n.kind]}\n→ ${n.action}`;
}

/**
 * Invoke the operator's hook. Never throws, never rejects, never blocks the
 * cycle for more than `NOTIFY_TIMEOUT_MS`.
 *
 * `spawnFn` exists so the offline suite can assert what would have been run
 * without spawning anything.
 */
export async function notify(
  n: Notification,
  spawnFn: typeof spawn = spawn,
): Promise<{ sent: boolean; reason?: string }> {
  const cmd = notifyCommand();
  if (!cmd) return { sent: false, reason: "PI_ENSEMBLE_NOTIFY_CMD not set" };
  const message = formatNotification(n);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { sent: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      if (!r.sent) trace(`work-notify: hook did not deliver — ${r.reason}`);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // The command runs through a shell so operators can write pipelines,
      // but the MESSAGE never touches that string — it goes down stdin.
      child = spawnFn(cmd, {
        shell: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, PI_ENSEMBLE_NOTIFY_MESSAGE: message },
      });
    } catch (err) {
      // A malformed command must not take the cycle with it.
      done({ sent: false, reason: (err as Error).message?.slice(0, 160) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone. Nothing to do, and nothing worth reporting.
      }
      done({ sent: false, reason: `hook did not exit within ${NOTIFY_TIMEOUT_MS}ms` });
    }, NOTIFY_TIMEOUT_MS);
    // Node keeps the event loop alive for a pending timer; a notification
    // must never be the reason a process lingers.
    timer.unref?.();
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ sent: false, reason: (err as Error).message?.slice(0, 160) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(
        code === 0
          ? { sent: true }
          : { sent: false, reason: `hook exited ${code ?? "with no code"}` },
      );
    });
    try {
      child.stdin?.on("error", () => {
        // A hook that ignores stdin (or exits before reading it) makes the
        // write fail with EPIPE. That is the hook's prerogative.
      });
      child.stdin?.end(message);
    } catch {
      // Same EPIPE case, surfaced synchronously on some platforms.
    }
  });
}
