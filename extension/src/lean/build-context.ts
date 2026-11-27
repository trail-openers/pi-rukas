/**
 * lean/build-context — the builder's brief, composed from the run's own record. Every reader is pure
 * over `Step[]` (no child, git tree or runner needed), and `review`/`verify`/acceptance read the same
 * frozen map here. `reentryFromLog` QUOTES a gate's red reason because a gate judged that round; the
 * other two report what NO gate judged — which is why one quotes and one names.
 */

import type { Step } from "./state.ts";
import { RED_REASON_CLIP, clipReason } from "./verify-deps.ts";

/** How many names one reason line lists before it says "and N more". */
const LIST_CLIP = 20;

/** A step that froze tests: a decided `specify:ok` or `challenge:new-tests`. */
function frozeTests(step: Step): boolean {
  return (
    (step.state === "specify" && step.outcome?.kind === "ok") ||
    (step.state === "challenge" && step.outcome?.kind === "new-tests")
  );
}

/** The step log's frozen map: every `specify:ok` / `challenge:new-tests`, in order. */
export function frozenFromLog(steps: Step[]): Record<string, string> {
  const frozen: Record<string, string> = {};
  for (const step of steps.filter(frozeTests))
    for (const [rel, sha] of Object.entries(step.outcome?.frozen ?? {})) frozen[rel] = sha;
  return frozen;
}

/** The criterion -> tests map, unioned over every step that recorded one: the run-level file quota
 *  bounds what a criterion ENDS UP WITH, and only this map knows what an earlier round froze. */
export function testsFromLog(steps: Step[]): Record<string, string[]> {
  const tests: Record<string, string[]> = {};
  for (const step of steps.filter(frozeTests)) {
    for (const [id, files] of Object.entries(step.outcome?.tests ?? {})) {
      const seen = new Set(tests[id] ?? []);
      for (const f of files) seen.add(f);
      tests[id] = [...seen];
    }
  }
  return tests;
}

/** The newest decided `state` + `kind` step's reason, clipped for a prompt. */
function reasonFromLog(
  steps: Step[],
  state: "verify" | "ci" | "build",
  kind: "red" | "budget",
): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const oc = steps[i]?.state === state ? steps[i]?.outcome : undefined;
    if (oc?.kind !== kind) continue;
    const reason = oc.reason ?? oc.message;
    if (typeof reason !== "string" || reason.trim() === "") continue;
    return clipReason(reason);
  }
  return undefined;
}

/** Why this round exists, in the gate's own words: newest decided `verify:red`, else `ci:red`. A
 *  round that came back from added tests is told by {@link addedByChallengeFromLog} instead. */
export function reentryFromLog(steps: Step[]): string | undefined {
  return reasonFromLog(steps, "verify", "red") ?? reasonFromLog(steps, "ci", "red");
}

/** What stopped the PREVIOUS attempt: the newest decided `build:budget` reason — no gate judged a
 *  killed builder, so `reentryFromLog` is silent and "it stopped" alone re-derives the feature. */
export function budgetStopFromLog(steps: Step[]): string | undefined {
  return reasonFromLog(steps, "build", "budget");
}

/** What the adversary added: the newest `challenge:new-tests`'s frozen paths, named not quoted —
 *  no gate judged them, the adversary only made the contract bigger. */
export function addedByChallengeFromLog(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== "challenge" || step.outcome?.kind !== "new-tests") continue;
    const paths = Object.keys(step.outcome.frozen ?? {});
    if (paths.length === 0) continue;
    const kept = paths.slice(0, LIST_CLIP).map((p) => `- \`${p}\``);
    const more = paths.length > LIST_CLIP ? `\n- …and ${paths.length - LIST_CLIP} more` : "";
    const line = `the adversary's challenge round added these frozen tests:\n${kept.join("\n")}${more}`;
    return line.length > RED_REASON_CLIP ? `${line.slice(0, RED_REASON_CLIP)}…` : line;
  }
  return undefined;
}
