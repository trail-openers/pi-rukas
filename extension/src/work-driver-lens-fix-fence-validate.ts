/**
 * work-driver-lens-fix-fence-validate — #1852: the runtime shape check on the
 * persisted lens-fix fence, split from `work-driver-lens-fix-fence-gate.ts` for
 * the AGENTS.md §12 size cap. It is re-exported from the gate module, so the two
 * readers (`lensFixFenceCheck` here, `workflow-state-validate.ts` at the read)
 * keep importing it from where they always did.
 *
 * Split along a real seam: the gate ANSWERS "may this round land", which needs a
 * worktree, git and the round's delta; this module only ASKS "is this record a
 * record at all", which needs no I/O at all and is therefore testable without a
 * fixture repo. Same #861 seam the consolidation and cap-evidence validators use.
 */

import { isValidBaseSha } from "./work-develop-git.ts";

/**
 * The shape of a `LensFixFenceSnapshot` that got into the state file whole
 * enough to be an object but is missing a field, or carries one of the wrong
 *
 * `pipelineState.lensFixFence` is read through an untyped cast in `readState`,
 * so the type is a compile-time claim only: a hand edit, a truncated write, or
 * an older build's partial record reaches the gate as `undefined` fields, and
 * `lensFixPlanFromSnapshot` turns a missing `fence` into a crash and a missing
 * `declared` into a fence that admits nothing and refuses nothing at once. The
 * #533 rule applies here as it does to `prDraft` and `commitPrRoot`: the cast
 * is the only runtime gate, so a partial record is a confident wrong answer and
 * must be reported, not executed. Absent validates (see `lensFixFenceCheck` —
 * no record at all is the older-driver case and is not judged).
 */
export function lensFixFenceFindings(snapshot: unknown): string[] {
  if (snapshot === undefined || snapshot === null) return [];
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return ["pipelineState.lensFixFence is not an object"];
  }
  const out: string[] = [];
  const s = snapshot as Record<string, unknown>;
  for (const field of ["workstreamId", "worktree", "findings"] as const) {
    if (typeof s[field] !== "string" || s[field] === "") {
      out.push(`pipelineState.lensFixFence.${field} is missing or not a string`);
    }
  }
  // #1852 follow-up — `roundTip` is not just any string: it is the revision the
  // round's delta is measured FROM, and it is interpolated into `git diff
  // <roundTip>..<head>` by `committedChanges` and into the ancestry probe by
  // `isAncestor`. Those two readers already refuse a non-SHA, but they answer
  // `unknown`/`not a SHA` and the gate then parks on a read failure — while the
  // shape this validator exists to catch is a record that is a perfectly good
  // object carrying a 7-char abbreviation or a `HEAD` token. `readState` casts
  // the whole record (#533), so the predicate is spelled here with the ONE
  // 40-hex owner the develop paths use rather than a fourth copy of the regex.
  if (!isValidBaseSha(s.roundTip)) {
    out.push("pipelineState.lensFixFence.roundTip is missing or not a 40-hex SHA");
  }
  for (const field of ["round"] as const) {
    if (typeof s[field] !== "number" || !Number.isFinite(s[field] as number)) {
      out.push(`pipelineState.lensFixFence.${field} is missing or not a finite number`);
    }
  }
  for (const field of ["declared", "named", "candidates"] as const) {
    if (!Array.isArray(s[field]) || !s[field].every((x) => typeof x === "string")) {
      out.push(`pipelineState.lensFixFence.${field} is missing or not an array of strings`);
    }
  }
  const fence = s.fence;
  if (typeof fence !== "object" || fence === null || Array.isArray(fence)) {
    out.push("pipelineState.lensFixFence.fence is missing or not an object");
  } else {
    const f = fence as Record<string, unknown>;
    if (typeof f.id !== "string" || f.id === "") {
      out.push("pipelineState.lensFixFence.fence.id is missing or not a string");
    }
    if (typeof f.ceilingBasis !== "string") {
      out.push("pipelineState.lensFixFence.fence.ceilingBasis is missing or not a string");
    }
    for (const field of [
      "admits",
      "declared",
      "helperDirs",
      "passChanged",
      "outOfScope",
    ] as const) {
      if (!Array.isArray(f[field]) || !f[field].every((x) => typeof x === "string")) {
        out.push(`pipelineState.lensFixFence.fence.${field} is missing or not an array of strings`);
      }
    }
    for (const field of ["ceiling", "admittingSlots"] as const) {
      if (typeof f[field] !== "number" || !Number.isFinite(f[field] as number)) {
        out.push(`pipelineState.lensFixFence.fence.${field} is missing or not a finite number`);
      }
    }
  }
  return out;
}
