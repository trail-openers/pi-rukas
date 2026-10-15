/**
 * work-driver-handoff-channel — who reports a handoff (#1327).
 *
 * `forge` (the default): the driver posts the handoff comment and applies
 * `needs-human-attention`, as it always has. `host`: whatever runs the cycle
 * owns that channel. The driver posts nothing and applies no label; the full
 * handoff body, with the typed cap and park reason, goes into the headless
 * `--json` result for the host to deliver (headless/handoff.ts).
 *
 * Either way the body starts with a machine marker,
 * `<!-- pi-rukas:handoff issue=N cap=<cap> -->`, so a reader can find the
 * handoff comment and extend it instead of posting a second one.
 */

import type { WorkState } from "./workflow-state.ts";

export type HandoffChannel = "forge" | "host";

export const HANDOFF_CHANNELS: readonly HandoffChannel[] = ["forge", "host"];

/** `PI_ENSEMBLE_HANDOFF_CHANNEL`; anything but `host` (any case) is `forge`. */
export function handoffChannel(): HandoffChannel {
  return process.env.PI_ENSEMBLE_HANDOFF_CHANNEL?.trim().toLowerCase() === "host"
    ? "host"
    : "forge";
}

/** The marker line. `cap=none` when the cycle recorded no cap. */
export function handoffMarker(issue: number, cap: string | undefined): string {
  // A cap never holds whitespace or `-->`; strip both so the comment cannot be closed early.
  const safe = (cap ?? "none").replace(/\s+|-->/g, "");
  return `<!-- pi-rukas:handoff issue=${issue} cap=${safe || "none"} -->`;
}

/** Parse a marker out of a comment body. The first marker wins. */
export function parseHandoffMarker(body: string): { issue: number; cap: string } | undefined {
  const m = body.match(/<!-- pi-rukas:handoff issue=(\d+) cap=(\S+) -->/);
  return m?.[1] && m[2] ? { issue: Number(m[1]), cap: m[2] } : undefined;
}

/** The handoff body with the marker as its first line (idempotent). */
export function withHandoffMarker(body: string, state: WorkState): string {
  if (parseHandoffMarker(body)) return body;
  const cap = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  return `${handoffMarker(state.issue, cap?.kind === "cap-hit" ? cap.cap : undefined)}\n${body}`;
}
