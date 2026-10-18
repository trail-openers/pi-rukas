/**
 * work-driver-verify-select-verdict — #1647: the pure decisions of the selected
 * verify's attribution. No I/O, no exec: the runner
 * (work-driver-verify-select-exec) gathers the facts and asks these functions
 * what they establish.
 *
 * "Pre-existing" is defined TWICE in this codebase, on purpose. The commit-pr
 * seam (work-driver-verify-attribution) excuses a name when it fails on the base
 * commit, once, by name. This module needs two agreeing base runs, the same
 * failure line on both sides, and a name-level check. The selected verify runs
 * on develop hosts that are loaded, where one red run is routinely a timing
 * failure; the seam runs once at a quiet point, where it is not. Changing the
 * seam's policy is out of scope for #1647.
 */

import { extensionRelative } from "./work-driver-verify-shared.ts";
import { failureSignatures } from "./work-driver-verify-signature.ts";

/** What one base probe established, as far as this decision needs it. */
export interface ProbeFacts {
  preExistingFailures: readonly string[];
  changeCausedFailures: readonly string[];
  probeOutput?: string;
}

/**
 * The names as extension-relative paths, or undefined when any one of them
 * cannot be placed under `extension/`.
 */
export function placeable(names: readonly string[]): string[] | undefined {
  const rels: string[] = [];
  for (const name of names) {
    const rel = extensionRelative(name);
    if (rel === undefined) return undefined;
    rels.push(rel);
  }
  return rels;
}

/**
 * The reason a baseline-red verdict cannot stand: a test that fails on base for
 * a different line than it fails on this change, or one that has a failure line
 * on base but none on this change (the same failure cannot be shown). A test
 * with no line on either side keeps the name-only verdict, which the caller
 * traces. Undefined when every test is excused.
 */
export function signatureClash(
  rels: readonly string[],
  change: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, string>,
): { reason: string } | { unsigned: string[] } | undefined {
  const unsigned: string[] = [];
  for (const rel of rels) {
    const c = change.get(rel);
    const b = base.get(rel);
    if (c !== undefined && b !== undefined) {
      if (c !== b) {
        return {
          reason: `${rel} fails on this change with "${c}" and on base with "${b}" — red on base for a different reason, so it is not excused`,
        };
      }
      continue;
    }
    if (c === undefined && b !== undefined) {
      return {
        reason: `${rel} fails on base with "${b}" but prints no failure line on this change, so the same failure cannot be shown and it is not excused`,
      };
    }
    unsigned.push(rel);
  }
  return unsigned.length > 0 ? { unsigned } : undefined;
}

/**
 * Judge one base probe of exactly `rels`. Passes only when no name is
 * change-caused, every name is red on base, and no name fails on base for a
 * different reason. `changeSignatures` and the probe's own output are the two
 * failure-line maps the signature check compares.
 */
export function judgeProbe(
  rels: readonly string[],
  probe: ProbeFacts,
  changeSignatures: ReadonlyMap<string, string>,
): { ok: true; unsigned: string[] } | { blocks: string } {
  if (probe.changeCausedFailures.length > 0) {
    return {
      blocks: `red on this change and green on base: ${probe.changeCausedFailures.join(", ")}`,
    };
  }
  const redOnBase = new Set(
    probe.preExistingFailures.map(extensionRelative).filter((r): r is string => r !== undefined),
  );
  if (!rels.every((r) => redOnBase.has(r))) {
    return { blocks: "a failing test was not shown to be red on the base commit" };
  }
  const clash = signatureClash(rels, changeSignatures, failureSignatures(probe.probeOutput ?? ""));
  if (clash !== undefined && "reason" in clash) return { blocks: clash.reason };
  return { ok: true, unsigned: clash !== undefined && "unsigned" in clash ? clash.unsigned : [] };
}

/**
 * What the first run's outcome obliges. A timed-out run and a run that names
 * no test block at develop; the ci tier (`rerunUnnamed`) reruns both once. A
 * named failure reruns its IDs through the probe shape; a timed-out or unnamed
 * failure reruns the whole command, because the named list cannot be trusted
 * to cover what it did not reach.
 */
export type FirstRunPlan = { kind: "block" } | { kind: "rerun-named" } | { kind: "rerun-whole" };

export function firstRunPlan(
  names: readonly string[],
  timedOut: boolean,
  rerunUnnamed: boolean,
): FirstRunPlan {
  if (!rerunUnnamed && (timedOut || names.length === 0)) return { kind: "block" };
  if (names.length > 0 && !timedOut) return { kind: "rerun-named" };
  return { kind: "rerun-whole" };
}
