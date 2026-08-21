/**
 * work-driver-handoff-adversarial — the adversarial-outcome sections of the
 * cap-hit handoff markdown body.
 *
 * Extracted from work-driver-handoff-markdown.ts (AGENTS.md §12 file-size
 * limit) — same split pattern as work-driver-adversarial-reentry.ts: pure
 * formatter primitives, value-imported one way, type-only the other, no
 * runtime cycle.
 *
 * The handoff body must tell the operator what the adversarial gate
 * ACTUALLY decided — the rounds that ran and what the reviewer objected to —
 * and it must keep the no-verdict infra-failure states distinct from a
 * genuine rejection (#478: an infra death in round 1's fix dispatch was
 * reported as "3 adversarial round(s), all rejected").
 *
 * - `adversarialRoundsLine` — the **Rounds** line, per the cap that fired.
 * - `adversarialOutcomeSection` — the reviewer's findings, or the explicit
 *   "no review rejection exists" body when the gate died on infrastructure.
 */

import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * Report the rounds that actually ran, for the cap that actually fired.
 *
 * `reviewRound` is the LENS counter. An adversarial cap reported it anyway, so
 * a cycle whose adversarial loop ran three full rounds told the human
 * `Rounds: 0 of 3` — lantern #664, verbatim. The reader's reasonable conclusion
 * is that nothing happened, when in fact three reviews and two fix rounds had.
 */
export function adversarialRoundsLine(
  state: WorkState,
  cap: string | undefined,
  reviewRound: number,
): string {
  if (cap === "adversarial-infra-failure") {
    // #485/#486 — a NO-VERDICT outcome must not render as "all rejected":
    // #478's incident was an infra death in round 1's fix dispatch reported
    // as "3 adversarial round(s), all rejected". The count is data now — the
    // per-workstream outcome event carries `roundsExecuted`.
    const out = [...state.eventLog]
      .reverse()
      .find(
        (e): e is Extract<WorkEvent, { kind: "adversarial-workstream-outcome" }> =>
          e.kind === "adversarial-workstream-outcome" &&
          (e.outcome === "infra-failure" || e.outcome === "dispatch-failed"),
      );
    return out
      ? `**Rounds**: ${out.roundsExecuted} review round(s) executed for workstream \`${out.workstreamId}\` before it failed — NO verdict exists for that workstream (this is NOT a review rejection)`
      : "**Rounds**: an adversarial loop failed on infrastructure before a verdict was produced";
  }
  if (cap === "adversarial-loop") {
    for (let i = state.eventLog.length - 1; i >= 0; i--) {
      const e = state.eventLog[i];
      if (e?.kind === "adversarial-rejected") {
        return `**Rounds**: ${e.rounds} adversarial round(s), all rejected`;
      }
    }
    return "**Rounds**: adversarial loop ran, round count unrecorded";
  }
  return `**Rounds**: ${reviewRound} of 3 review rounds`;
}

/**
 * What the reviewer actually objected to.
 *
 * The handoff used to say only "the diff still has issues the
 * adversarial-developer flagged", which sends the reader to dig through
 * transcripts for the one thing they need. The findings are already on the
 * event; print them.
 *
 * #485 — an infra-failure findings blob ("No verdict was produced — this is
 * NOT a review rejection") must not be rendered under "What the reviewer
 * objected to": the loop classified itself correctly and this section then
 * contradicted it. The workstream-outcome events tell the two apart.
 */
export function adversarialOutcomeSection(state: WorkState): string[] {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind !== "adversarial-rejected") continue;
    const findings = e.findings?.trim();
    if (!findings) break;
    const wsOutcomes = new Map<string, string>();
    for (const ev of state.eventLog) {
      if (ev.kind === "adversarial-workstream-outcome") wsOutcomes.set(ev.workstreamId, ev.outcome);
    }
    const isInfraSection = (section: string): boolean => {
      // #486 — the driver tags no-verdict workstreams with an explicit
      // marker (their loop died, nothing was reviewed). The marker, not
      // prose-matching, is what keeps a genuine rejection that merely
      // MENTIONS an infra failure from being filtered out of the handoff.
      if (section.includes("never produced a verdict")) return true;
      const m = section.match(/^\[workstream (\S+)\]/);
      const id = m?.[1];
      if (!id) return false;
      const o = wsOutcomes.get(id);
      return o === "infra-failure" || o === "dispatch-failed";
    };
    const sections = findings
      .split(/\n\n---\n\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const rejected = sections.filter((s) => !isInfraSection(s));
    if (rejected.length === 0) {
      return [
        "### Adversarial outcome",
        "",
        "No review rejection exists — the adversarial gate failed on infrastructure before a",
        "verdict was produced (the per-round records in the state file say how far each loop",
        "got). This is not a review rejection, and any workstream that DID reach a verdict is",
        "recorded in the `adversarial-workstream-outcome` events.",
        "",
      ];
    }
    return [
      "### What the reviewer objected to",
      "",
      rejected.length > 4000
        ? `${rejected.slice(0, 4000)}\n\n…(truncated)`
        : rejected.join("\n\n---\n\n"),
      "",
    ];
  }
  return [];
}
