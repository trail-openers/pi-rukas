/**
 * test-forge-gl-approvals-optional.ts — `approvals_left` is OPTIONAL on the
 * single-MR reply (#2396).
 *
 * GitLab reports outstanding approvals on a separate endpoint
 * (`/merge_requests/:iid/approvals`), so the reply `glab mr view` returns — and
 * the same payload over `glab api /projects/:id/merge_requests/:iid` — has never
 * carried the key. The composition required it, so EVERY real MR failed closed:
 * the pilot's ready MR answered exactly the row below and was refused naming a
 * field the API does not send, which killed lean's `ci` step and the land gate's
 * evidence read at once.
 *
 * `detailed_merge_status` is the authoritative field and pending approvals
 * already arrive through it as `not_approved`, DIRTY; a number that IS present
 * stays a cross-check able to refuse a CLEAN it contradicts. The optional rule is
 * about an ABSENT field, so it is pinned across the mapped statuses — CLEAN,
 * DIRTY and UNKNOWN alike — and a value of any other type stays malformed.
 *
 * Split out of `test-forge-gl-detailed-status.ts` for the §12 size cap along the
 * seam the cases already had: that file asks what each STATUS composes, this one
 * asks what one FIELD being absent does, whatever the status.
 *
 * Run: cd extension && bun run smoke-tests/test-forge-gl-approvals-optional.ts
 */

import { composeGlReadiness } from "../src/forge.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

/** The MR reply `glab mr view` ACTUALLY answered for a ready MR in the field:
 *  the readiness fields that endpoint does send, and no `approvals_left` key. */
const LIVE_MR_VIEW: Record<string, unknown> = {
  detailed_merge_status: "mergeable",
  has_conflicts: false,
  blocking_discussions_resolved: true,
  draft: false,
  state: "opened",
};

/** The row of a mapped status whose reply is the live shape plus that status. */
const liveRow = (status: string, over: Record<string, unknown> = {}) => ({
  ...LIVE_MR_VIEW,
  detailed_merge_status: status,
  ...over,
});

async function main() {
  /** The message a composition refuses with, or `undefined` when it answered. */
  const throwsWith = (mr: Record<string, unknown>) => {
    try {
      composeGlReadiness(mr);
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  };
  /** A detail that named a field the reply never sent is a value nobody sent:
   *  `approvals_left=undefined` / `=null` is a lie about the forge's reply. */
  const noFragment = (detail: string) =>
    `a skipped field leaves no fragment in the detail: ${detail}`;

  console.log("approvals_left is optional on the single-MR reply:");
  await check("  the live MR-view shape (no approvals_left) composes CLEAN", () => {
    const composed = composeGlReadiness(LIVE_MR_VIEW);
    assert(composed.readiness === "CLEAN", `got ${composed.readiness}`);
    assert(!composed.detail.includes("approvals_left"), noFragment(composed.detail));
  });
  await check("  not_approved with no approvals_left composes DIRTY naming the value", () => {
    const composed = composeGlReadiness(liveRow("not_approved"));
    assert(composed.readiness === "DIRTY", `got ${composed.readiness}`);
    assert(composed.detail.includes("not_approved"), `detail: ${composed.detail}`);
    assert(!composed.detail.includes("approvals_left"), noFragment(composed.detail));
  });
  await check("  approvals_left null is skipped, not refused", () => {
    const composed = composeGlReadiness(liveRow("mergeable", { approvals_left: null }));
    assert(composed.readiness === "CLEAN", `got ${composed.readiness}`);
    assert(!composed.detail.includes("approvals_left"), noFragment(composed.detail));
  });
  // The optional rule is not a `mergeable` arm: absent and null are skipped for
  // every mapped status, and neither leaves an empty fragment behind.
  for (const [status, want] of [
    ["need_rebase", "DIRTY"],
    ["ci_still_running", "UNKNOWN"],
  ] as const) {
    for (const absent of [undefined, null]) {
      await check(`  ${status} with approvals_left ${String(absent)} composes ${want}`, () => {
        const composed = composeGlReadiness(liveRow(status, { approvals_left: absent }));
        assert(composed.readiness === want, `got ${composed.readiness}, want ${want}`);
        assert(composed.detail.includes(status), `detail names the value: ${composed.detail}`);
        assert(!composed.detail.includes("approvals_left"), noFragment(composed.detail));
      });
    }
  }
  // A reply that DOES carry the field is still cross-checked, and still must be
  // readable: optionality is about absence, never about any other type.
  await check("  a present approvals_left > 0 still refuses a CLEAN", () => {
    const msg = throwsWith(liveRow("mergeable", { approvals_left: 1 }));
    assert(msg !== undefined && msg.includes("approvals_left"), `wrong: ${msg}`);
  });
  await check("  a non-number approvals_left is still malformed, naming the field", () => {
    for (const status of ["mergeable", "need_rebase", "ci_still_running"]) {
      const msg = throwsWith(liveRow(status, { approvals_left: "x" }));
      assert(msg !== undefined && msg.includes("approvals_left"), `${status}: wrong: ${msg}`);
    }
  });

  forgeExitCode("All GitLab optional-approvals tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
