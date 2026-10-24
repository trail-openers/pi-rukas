/**
 * Shared fixtures for the #1756 part-b `paths`-ceiling tests. The defect was a
 * schema `maxItems` on `paths` that refused the WHOLE `report_workstream` call
 * at the 51st declared path, so every case here needs a list of an arbitrary
 * size that is still a legal plan: distinct, plain, repo-relative paths, short
 * enough for `WORKSTREAM_PATH_MAX`. Kept in one place so the bound test and any
 * later regression cannot drift apart on what a legal crowded plan looks like.
 *
 * `VALID_ARGS` is `VALID` from `plan-outofscope-fixtures.ts` — the same minimal
 * accepted call, which is what `crowdedArgs` spreads here, so the two fixture
 * modules cannot drift on what an accepted call is and there is no second name
 * for it to re-export.
 */
import type { WorkstreamArgs } from "../../src/plan-workstream-schema.ts";
import { VALID } from "./plan-outofscope-fixtures.ts";

/**
 * N distinct plain repo-relative paths, all legal under the per-entry bound.
 *
 * The prefix is short and the fill goes at the END of the last segment on
 * purpose: a long name in a MIDDLE segment is what a formatter wraps across
 * lines, and a wrapped template literal that a later `.ts` hangs off silently
 * changed one fixture's length by 3 characters — enough to make a "one over the
 * limit" assertion judge a number nothing enforces.
 */
export function pathList(n: number, prefix = "src/mod"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}.ts`);
}

/**
 * A crowded plan: one workstream that declares `paths`, for the cases that
 * judge what a gate does with a list a develop prompt cannot print in full.
 *
 * This is the ONLY way a case should build its call arguments: a hand-spelled
 * `{ ...VALID, … }` literal has two orders to get wrong, and a `paths` written
 * before the spread is silently overwritten by `VALID.paths`.
 */
export function crowdedArgs(id: string, paths: string[]): WorkstreamArgs {
  return { ...VALID, id, paths };
}
