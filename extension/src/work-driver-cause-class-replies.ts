/**
 * work-driver-cause-class-replies — how a cause verdict reads the DEVELOP replies,
 * split out of `work-driver-cause-class.ts` (AGENTS.md §12 size cap; this is the
 * event-log-reading half of that verdict, with no dependency on the classifier itself).
 *
 * A `develop-empty-diff` park has two very different causes and the developer's own
 * reply tells them apart: a child that stopped to ask the operator a question needs the
 * operator (`issue`), while one that changed nothing for a reason of its own has a defect
 * in the change (`change`). Both readings quote the reply, so this module owns WHICH
 * reply is quoted and how it is attributed when a fan-out produced several.
 */

import { PLUMB_REPLY_MARKER } from "./work-driver-adversarial-plumb.ts";
import type { WorkState } from "./workflow-state.ts";

/** A develop reply to quote, with the workstream it came from when a fan-out named one. */
export interface QuotedReply {
  id?: string;
  text: string;
  /** The reply is a placeholder because the workstream produced none. */
  missing?: boolean;
}

const NO_REPLY = "(no reply recorded)";
const PLUMB_QUESTION = /^[*_]*question[*_]*\s*:/i;

/**
 * The develop replies the verdict quotes. Under a fan-out these are the reply(s)
 * of the workstream(s) that produced no change (a no-change green is downgraded
 * to failing, so the downgraded workstreams are that set), else of every failing
 * workstream. With no failing workstream, the developer's last reply.
 */
export function quotedReplies(state: WorkState): QuotedReply[] {
  const replies = new Map<string, string>();
  const verdicts = new Map<string, { ok: boolean; downgraded: boolean }>();
  let last: string | undefined;
  for (const e of state.eventLog) {
    if (e.kind === "dispatch-completed" && e.step === "develop" && e.role === "developer") {
      if (e.summary?.trim()) {
        replies.set(e.label, e.summary);
        last = e.summary;
      }
    } else if (e.kind === "branch-completed" && e.step === "develop") {
      verdicts.set(e.workstreamId, { ok: e.ok, downgraded: e.downgrade === true });
    }
  }
  const failing = [...verdicts].filter(([, v]) => !v.ok);
  const noChange = failing.filter(([, v]) => v.downgraded);
  const chosen = (noChange.length > 0 ? noChange : failing).map(([id]) => id);
  const picked: QuotedReply[] = [];
  for (const id of chosen) {
    const text =
      replies.get(`developer[${id}]`) ??
      (chosen.length === 1 ? replies.get("developer") : undefined);
    picked.push(text === undefined ? { id, text: NO_REPLY, missing: true } : { id, text });
  }
  if (picked.length > 0) return picked;
  return last === undefined ? [] : [{ text: last }];
}

/** Evidence lines from the quoted replies: named by workstream only when several are quoted. */
export function tagged(
  replies: readonly QuotedReply[],
  lines: (r: QuotedReply) => string[],
): string[] {
  const named = replies.length > 1;
  return replies.flatMap((r) =>
    lines(r).map((l) =>
      r.id !== undefined && (named || r.missing === true) ? `workstream ${r.id}: ${l}` : l,
    ),
  );
}

/**
 * The question a developer's reply asks the operator: the `question:` line of
 * its `[ensemble:plumb]` block, or the block's first line. Undefined when the
 * reply has no plumb block.
 */
export function plumbQuestion(reply: string): string | undefined {
  const at = reply.indexOf(PLUMB_REPLY_MARKER);
  if (at < 0) return undefined;
  const lines = reply
    .slice(at + PLUMB_REPLY_MARKER.length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.find((l) => PLUMB_QUESTION.test(l)) ?? lines[0] ?? PLUMB_REPLY_MARKER;
}
