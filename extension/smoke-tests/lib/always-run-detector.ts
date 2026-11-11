/**
 * #1647 — the always-run detector, re-exported for the smoke tests that gate its
 * membership. The predicate itself ships in `src/work-driver-verify-always-run.ts`
 * because the develop-time selector computes the always-run set from the
 * worktree's own smoke tests; nothing generates or commits a list any more.
 */
export {
  readsRepositoryText,
  textReadingTests,
} from "../../src/work-driver-verify-always-run.ts";
