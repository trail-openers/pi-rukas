/**
 * lens-skill-trace — the shadow log line for a claimed skill load (#872 /
 * PR #1530). Split out of lens-review-child.ts (AGENTS.md §12).
 *
 * The proof itself lives in lens-skill-load-proof.ts; this is the reporting
 * half: how the tool calls a claimed SUCCESS was checked against get rendered
 * into the trace, and what absence of the self-report marker means. Both are
 * diagnosis only — neither blocks a lens, which is what shadow mode means.
 */

import { skillLoadProof } from "./lens-skill-load-proof.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { readEnumMarker } from "./reply-markers.ts";
import { trace, traceWarn } from "./trace.ts";

export function describeToolCalls(toolUses: readonly unknown[]): string {
  const names: string[] = [];
  const paths: string[] = [];
  for (const tu of toolUses ?? []) {
    if (!tu || typeof tu !== "object") continue;
    const call = tu as Record<string, unknown>;
    const name = typeof call.name === "string" ? call.name : "?";
    if (names.length < 8 && !names.includes(name)) names.push(name);
    const args =
      call.arguments && typeof call.arguments === "object"
        ? (call.arguments as Record<string, unknown>)
        : {};
    for (const key of ["path", "file_path"]) {
      const v = args[key];
      if (typeof v === "string" && v.trim() && paths.length < 8 && !paths.includes(v)) {
        paths.push(v);
      }
    }
  }
  const seen = names.length > 0 ? names.join(", ") : "(none)";
  const withPaths = paths.length > 0 ? `; paths ${paths.join(", ")}` : "";
  return `${toolUses?.length ?? 0} tool call(s) [tools ${seen}]${withPaths}`;
}

// #872 — honor-system absence is traced, not blocked: the marker was not
// emitted, but the pre-spawn statSync in `runLensChild` is the executed
// evidence the skill exists, so an absent marker never blocks — and a SUCCESS
// whose read the child did not perform is downgraded to FAILED above rather
// than reaching this line.
export function traceSkillLoadAbsence(lensSkill: string, status: string | undefined): void {
  if (status === undefined) {
    trace(`skill load status absent (${lensSkill}) — pre-spawn stat passed; marker not emitted`);
  }
}

/**
 * The skill-load gate for one lens reply: the child's own
 * `Skill Load Status:` marker, plus the #995/#1530 cross-check of a claimed
 * SUCCESS against the tool calls it actually made.
 *
 * Returns the marker and whether the lens is BLOCKED by it. Only the child's
 * own marker blocks — the proof runs in SHADOW (see `lens-skill-load-proof.ts`)
 * because a false `unproven` would block every lens review on every PR, and two
 * false-refutation classes are still open. The `blocked` result is the whole
 * contract: callers must not re-derive it from the status.
 */
export function skillLoadGate(
  text: string,
  toolUses: readonly unknown[],
  observedToolCalls: number | undefined,
  lensSkill: string,
  skillPath: string,
): { status: string | undefined; blocked: boolean } {
  const status = readEnumMarker(text, "Skill Load Status", ["SUCCESS", "FAILED"]);
  if (status === "SUCCESS") {
    const proof = skillLoadProof(toolUses, skillPath, observedToolCalls);
    switch (proof) {
      case "proven":
        break;
      case "unproven":
        traceWarn(
          `skill load SHADOW: SUCCESS not corroborated (${lensSkill}): no read of ${skillPath} among ${describeToolCalls(toolUses)} — NOT blocking (shadow mode; the child's own marker decides)`,
        );
        break;
      case "unverifiable":
        trace(
          `skill load SUCCESS unverifiable (${lensSkill}): the child recorded no usable tool calls; treated as absent, not refuted`,
        );
        break;
    }
  }
  return { status, blocked: status === "FAILED" };
}
