/**
 * lean/build-blocked — the anti-forgery gate for the build child's "these
 * frozen tests cannot all pass together" report.
 *
 * The child's report is narration, not executed evidence (AGENTS.md §7 rule 1).
 * A builder that could end a run by naming a conflict would end runs whose
 * contract it never read — or whose contract is perfectly satisfiable, which is
 * the exact shape of a child that gave up on the hard case. So the driver
 * honours the report only when BOTH of these hold, and the second one is a
 * command the driver itself ran:
 *
 *   1. **every named path is in the run's frozen map** — read off the same
 *      `frozenFromLog` every other reader of the contract uses, so a file the
 *      child merely imagined is not evidence;
 *   2. **at least one named frozen test comes back red on the child's tree**,
 *      run with the project's own `verify.test` template through the same
 *      runner `verify` and `specify` use (`runTestFile`, argv form, no shell).
 *
 * A runner that could not be started or was killed is NOT a red — it observed
 * nothing — and the report is ignored rather than honoured on a toolchain fault.
 * A green named test is not a conflict either. When the report is ignored the
 * caller traces the reason and continues its ordinary `ok`/`exhausted` path:
 * there is no third verdict, and nothing is recorded.
 *
 * The entry and reason bounds here are the DURABLE record's bounds, so an entry
 * that could not be persisted is refused before anything is spent running it.
 */

import { trace } from "../trace.ts";
import type { BuildExec } from "./build-types.ts";
import { runTestFile } from "./specify-proof.ts";
import { frozenKeyProblem } from "./state-outcome.ts";

/** How many conflicts one report may name. The durable record's bound. */
export const BLOCKED_MAX_ENTRIES = 32;

/** How long one stated conflict may be. The durable record's bound. */
export const BLOCKED_MAX_REASON_CHARS = 300;

/**
 * The child's reported conflicts, filtered to entries the record could hold.
 *
 * Order is the child's: the first entry that runs red is the one the handback
 * names, and a re-sorted list would print a different cause than the builder
 * saw first. A path that is not a legal frozen key is dropped here rather than
 * later, so a junk entry never reaches a `git`/runner call.
 */
export function usableConflicts(rows: Array<{ path: string; reason: string }>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.size >= BLOCKED_MAX_ENTRIES) break;
    if (typeof row.reason !== "string" || row.reason.length > BLOCKED_MAX_REASON_CHARS) continue;
    if (frozenKeyProblem(row.path) !== undefined) continue;
    seen.add(row.path);
  }
  return [...seen];
}

/** What the gate decided, and the sentence the caller traces when it refused. */
export type BlockedVerdict =
  | { honoured: true }
  /** `why` is the reason the report was ignored, for the trace line. */
  | { honoured: false; why: string };

/**
 * Did the driver itself prove the named tests disagree?
 *
 * `wt` is the child's tree — the one it was left in, before any reset — so the
 * red is a fact about the work the child did, not about the base commit.
 */
export async function blockedProved(opts: {
  exec: BuildExec;
  wt: string;
  template: string | undefined;
  frozen: Record<string, string>;
  paths: string[];
  /** Bounds one runner; a test shortens it to observe a hang. */
  timeoutMs?: number;
  /** Test-only hook, run here: the tree at the instant the gate judges it. */
  probe?: (wt: string) => void;
}): Promise<BlockedVerdict> {
  const { exec, wt, template, frozen, paths } = opts;
  if (paths.length === 0) return { honoured: false, why: "the report named no usable path" };
  if (paths.length > BLOCKED_MAX_ENTRIES)
    return { honoured: false, why: `the report named more than ${BLOCKED_MAX_ENTRIES} files` };
  if (template === undefined || template.trim() === "")
    return { honoured: false, why: "no verify.test runner is configured to re-check it with" };
  opts.probe?.(wt);
  const unvetted = paths.filter((p) => frozen[p] === undefined);
  if (unvetted.length > 0)
    return {
      honoured: false,
      why: `named ${unvetted.length} file(s) the run never froze: ${unvetted.slice(0, 4).join(", ")}`,
    };
  for (const file of paths) {
    const proof = await runTestFile(exec, {
      wt,
      template,
      file,
      ...(opts.timeoutMs === undefined ? {} : { limits: { timeoutMs: opts.timeoutMs } }),
    });
    // `red` and `unclear` both mean the file ran and did not pass; `unclear` is
    // still a red for `verify` (see `frozenTestFailure`), so it counts here too.
    if (proof.kind === "red" || proof.kind === "unclear") return { honoured: true };
    if (proof.kind === "infra") {
      trace(`lean build: blocked report not verified — ${file}: ${proof.detail}`);
      return { honoured: false, why: `the runner could not judge ${file}: ${proof.detail}` };
    }
  }
  return {
    honoured: false,
    why: "every named frozen test passed, so nothing was proved unsatisfiable",
  };
}
