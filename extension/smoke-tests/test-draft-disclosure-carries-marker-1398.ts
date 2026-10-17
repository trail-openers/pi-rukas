#!/usr/bin/env bun
/**
 * #1398 round 3 — every fact that says "the findings were disclosed" must
 * correspond to a comment the PR actually carries, with the marker on it.
 *
 * The round-cap route (`work-driver-lens-cap.ts`) posted its residual-findings
 * comment and recorded the `lens-residuals-posted` FACT — but the body it
 * posted was `renderResidualFindings(...)` with no `lensResidualsMarker`, and
 * that is the exact string both readers compare:
 *
 *   - `prCarriesDisclosure` (work-driver-draft-hold.ts) — the draft gate's
 *     "did this patch's disclosure reach the PR?";
 *   - `mergeGuardRoundCap` condition 5 (merge-guard-round-cap.ts) — the merge
 *     gate's disclosure condition.
 *
 * So the fact licensed a ready the PR itself could not show: a reader of the
 * state file saw a disclosure, a reader of the PR saw prose that merely looked
 * like one. Pinned here in three directions:
 *
 *  1. the round-cap post carries the marker, computed the same way
 *     `lens-review-residuals.ts` computes it;
 *  2. a body WITHOUT a marker is a FAILED disclosure — the cycle parks rather
 *     than carry findings under an unreadable-as-evidence comment;
 *  3. every writer of the fact emits the marker ON the event row, so the
 *     invariant is checkable from the state alone.
 *
 * Offline: fake git/gh, no model, no network.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lensResidualsMarker } from "../src/merge-guard-round-cap.ts";
import { recordLensResidualsPosted } from "../src/work-driver-draft-disclosure.ts";
import { prCarriesDisclosure } from "../src/work-driver-draft-hold.ts";
import { appendReviewCapHit, renderResidualFindings } from "../src/work-driver-lens-cap.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import {
  BRANCH,
  OTHER_PATCH,
  PATCH,
  PR,
  issuesFound,
  mkAssert,
  mkCtx,
  started,
  state,
} from "./lib/draft-rearm-fixtures.ts";

const { assert, status } = mkAssert();

// The findings blob is what the lens step PERSISTS — a JSON array, which is
// what `renderLensFindings` parses (`parseFindings` returns [] for prose, and
// an empty render is a failed disclosure, so a prose fixture would test the
// wrong thing).
const FINDINGS = JSON.stringify([
  { lens: "SIMPLICITY", severity: "MEDIUM", path: "src/a.ts", line: 12, title: "duplicated guard" },
  { lens: "SECURITY", severity: "HIGH", path: "src/b.ts", line: 3, title: "unbounded read" },
]);
/** The event log the round-cap route needs: an approved adversarial gate. */
const roundCapEvents: WorkEvent[] = [
  started("commit-pr", 1),
  { kind: "adversarial-approved", at: 1_000_002, jobId: "adv", round: 1 },
  issuesFound(3),
];

// ═══════════ 1. the renderer puts the marker on the body it is given ═══════════
{
  const marker = lensResidualsMarker(BRANCH, PATCH);
  const withMarker = renderResidualFindings(FINDINGS, 3, "ISSUES_FOUND", marker);
  assert(
    withMarker.includes(marker),
    "renderResidualFindings appends the disclosure marker when the caller passes one, so the comment is the same shape lens-review-residuals.ts posts",
  );
  assert(
    prCarriesDisclosure([withMarker], BRANCH, PATCH) === true,
    "…and the draft gate's own predicate reads that body as a disclosure — the fact and the comment agree by construction",
  );
  assert(
    prCarriesDisclosure([withMarker], BRANCH, OTHER_PATCH) === false,
    "…and a marker for another patch is not a disclosure for THIS one (the marker is the identity, not decoration)",
  );

  const withoutMarker = renderResidualFindings(FINDINGS, 3, "ISSUES_FOUND");
  assert(
    !withoutMarker.includes("pi-rukas:lens-residuals"),
    "with no marker passed, the body carries none — which is the shape that used to license a fact the PR could not show",
  );
  assert(
    prCarriesDisclosure([withoutMarker], BRANCH, PATCH) === false,
    "…and the gate holds on it: prose that reads like a disclosure is not one",
  );
}

// ═══════════ 2. the round-cap route posts the marker, or parks ═══════════
{
  // A cycle at the round cap with the adversarial gate approved: the route that
  // discloses must post the marker AND record the fact, keyed on the same id.
  const gh: string[] = [];
  const bodies: string[] = [];
  const { ctx } = mkRoundCapCtx(gh, bodies);
  const before = state(roundCapEvents, { status: "draft" });
  const after = await appendReviewCapHit(ctx, before, 3, "ISSUES_FOUND", FINDINGS);
  const fact = after.eventLog.find((e) => e.kind === "lens-residuals-posted");
  const cap = [...after.eventLog].reverse().find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "round-cap" && cap.nextStep === "ci",
    `the disclosed round cap still routes to ci (got ${JSON.stringify(cap)})`,
  );
  assert(
    bodies.length === 1 && bodies[0]?.includes(lensResidualsMarker(BRANCH, PATCH)),
    `the round-cap comment itself carries the marker (posted: ${JSON.stringify((bodies[0] ?? "").slice(-90))})`,
  );
  assert(
    fact?.kind === "lens-residuals-posted" && fact.patchId === PATCH,
    "…and the recorded fact is keyed on the same patch identity the comment carries",
  );
  assert(
    fact?.kind === "lens-residuals-posted" && fact.marker === lensResidualsMarker(BRANCH, PATCH),
    "…and the fact row itself carries the marker string, so the invariant is auditable from the state file",
  );
  assert(
    after.pipelineState.prDraft?.findingsPosted?.some((f) => f.patchId === PATCH) === true,
    "…and the mirror row matches, so the handoff and the gate see the same disclosure",
  );
}

{
  // A comment that would carry no marker is a FAILED disclosure: the identity
  // could not be computed, so nothing anchors the fact, and the cycle parks.
  const gh: string[] = [];
  const bodies: string[] = [];
  const { ctx } = mkRoundCapCtx(gh, bodies, (async (cmd: string, opts?: { argv?: string[] }) => {
    if (/^gh\b/.test(commandOf(cmd, opts))) {
      gh.push(commandOf(cmd, opts));
      return { stdout: "ok\n" };
    }
    if (cmd.startsWith("git merge-base")) throw new Error("fatal: not something we can merge");
    if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
    if (cmd.startsWith("git config --get remote.")) return { stdout: "https://github.com/o/r\n" };
    return { stdout: "" };
  }) as never);
  const before = state(roundCapEvents, { status: "draft" });
  const after = await appendReviewCapHit(ctx, before, 3, "ISSUES_FOUND", FINDINGS);
  const cap = [...after.eventLog].reverse().find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "round-cap" && cap.nextStep === "handoff",
    `an unmarkable disclosure parks rather than carrying findings into CI (got ${JSON.stringify(cap)})`,
  );
  assert(
    !after.eventLog.some((e) => e.kind === "lens-residuals-posted"),
    "…and no disclosure fact is recorded for a comment that was never posted",
  );
  assert(
    gh.every((c) => !/^gh pr comment/.test(c)),
    "…and no marker-less comment was posted to masquerade as a disclosure",
  );
  const plumbs = after.pipelineState.plumbReports ?? [];
  assert(
    plumbs.some((r) => /disclosure marker|patch identity/i.test(r.body)),
    `and the handoff explains WHY the disclosure could not be made (${JSON.stringify(plumbs.map((p) => p.body.slice(0, 70)))})`,
  );
}

// ═══════════ 3. every writer of the fact emits a marker on its row ═══════════
{
  // The ordinary disclosure path: the fact row must carry the marker the
  // disclosure post carries, or the gate is trusting a row nothing corroborates.
  const out = await recordLensResidualsPosted(
    mkCtx({ prView: async () => ({ number: PR, state: "OPEN", headRefName: BRANCH }) } as never),
    state([started("lens-review", 2), issuesFound(3)], { status: "draft" }),
    { round: 1, prNumber: PR },
  );
  const rows = out.eventLog.filter((e) => e.kind === "lens-residuals-posted");
  assert(rows.length === 1, `the disclosure path records exactly one fact (got ${rows.length})`);
  const row = rows[0];
  assert(
    row?.kind === "lens-residuals-posted" &&
      prCarriesDisclosure([`arbitrary body\n${row.marker}`], row.branch, row.patchId),
    "the marker on the row is the marker the PR must carry — one construction, both readers",
  );
  assert(
    validateDiscriminants(out).length === 0,
    `a state carrying the new marker field validates clean (${JSON.stringify(validateDiscriminants(out))})`,
  );
}

// ═══════════ 4. item 3 — a cycle with no draft fact gets no synthesised draft ═══════════
{
  const out = await recordLensResidualsPosted(
    mkCtx({ prView: async () => ({ number: PR, state: "OPEN", headRefName: BRANCH }) } as never),
    state([started("lens-review", 2), issuesFound(3)], undefined),
    { round: 2, prNumber: PR },
  );
  const draft = out.pipelineState.prDraft;
  assert(
    draft !== undefined && draft.findingsPosted?.length === 1,
    "the disclosure row is recorded on a cycle that has no draft fact at all",
  );
  assert(
    draft?.status === undefined,
    `…and NO \`status\` is synthesised — the driver never opened this PR as a draft and must not claim it is holding one (got ${JSON.stringify(draft?.status)})`,
  );
  assert(
    validateDiscriminants(out).length === 0,
    "…and the disclosure-only record is a VALID state (an absent status is legal; an unrecognised one is not)",
  );
  const corrupt = {
    ...out,
    pipelineState: { ...out.pipelineState, prDraft: { status: "bogus" } },
  } as unknown as WorkState;
  assert(
    validateDiscriminants(corrupt).some((f) => /prDraft.status/.test(f)),
    "…and the validator still refuses a corrupt status, so optionality did not loosen the gate",
  );
}

// ═══════════ 5. item 4 — an uncomputable identity says so in the handoff ═══════════
{
  const noIdentity = mkCtx({ prView: async () => ({}) } as never) as Record<string, unknown>;
  noIdentity.verifyExecFn = (async (cmd: string) => {
    if (cmd.startsWith("git merge-base")) throw new Error("fatal: not something we can merge");
    if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
    // The remote probe ANSWERS, so the identity fails on the injected merge-base
    // error and not on "no git remote" — the test asserts the named git error
    // reaches the handoff, so it has to be the error the fixture means to inject.
    if (cmd.startsWith("git config --get remote.")) return { stdout: "https://github.com/o/r\n" };
    return { stdout: "" };
  }) as never;
  const out = await recordLensResidualsPosted(
    noIdentity as never,
    state([started("lens-review", 2), issuesFound(3)], { status: "draft" }),
    { round: 1, prNumber: PR },
  );
  assert(
    !out.eventLog.some((e) => e.kind === "lens-residuals-posted"),
    "no fact is recorded when the patch identity cannot be computed (an unanchored fact would license a ready for a patch nobody verified)",
  );
  const plumbs = out.pipelineState.plumbReports ?? [];
  assert(
    plumbs.length === 1 && /not something we can merge/.test(plumbs[0]?.body ?? ""),
    `…but the decline is recorded as a plumb-report naming the git error, so the handoff explains the hold (${JSON.stringify(plumbs.map((p) => p.body.slice(0, 80)))})`,
  );
  assert(
    plumbs.length === out.eventLog.filter((e) => e.kind === "plumb-report").length &&
      plumbs.length === 1,
    "…and it lands on BOTH the rendered field and the event log, in equal measure (a signal nothing reads is not a signal)",
  );
  // The second decline is the same call, on the state the first one returned —
  // the shape the round-cap route produces when it computes an identity, fails
  // to post, and then calls the recorder with the same uncomputable identity.
  const again = await recordLensResidualsPosted(noIdentity as never, out, {
    round: 1,
    prNumber: PR,
  });
  assert(
    (again.pipelineState.plumbReports ?? []).length === 1 &&
      again.eventLog.filter((e) => e.kind === "plumb-report").length === 1,
    `…and the same decline recorded twice is ONE row on both records (${(again.pipelineState.plumbReports ?? []).length} field / ${again.eventLog.filter((e) => e.kind === "plumb-report").length} event) — a duplicate reads as two problems`,
  );
}

/**
 * A round-cap context: `gh` captured (the comment post and its body file), git
 * answered so `currentPatchIdentity` resolves to `PATCH`.
 *
 * `repoRoot` is a real temp directory: the round-cap route writes the comment
 * body to `<repoRoot>/tmp/issue-<N>/` before posting it, so a fake path makes
 * every disclosure fail on the write rather than on the thing under test.
 */
function mkRoundCapCtx(gh: string[], bodies: string[], execOverride?: never) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-marker-"));
  const { execFn } = gitForRoundCap(gh, bodies);
  return {
    ctx: {
      repoRoot,
      issue: 1398,
      verifyExecFn: (execOverride ?? execFn) as never,
    } as unknown as Parameters<typeof appendReviewCapHit>[0],
    repoRoot,
  };
}

function gitForRoundCap(gh: string[], bodies: string[]) {
  const execFn = async (cmd: string, opts?: { argv?: string[] }): Promise<{ stdout: string }> => {
    const line = commandOf(cmd, opts);
    if (/^gh\b/.test(line)) {
      gh.push(line);
      const file = /--body-file\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(line);
      const path = file?.[2] ?? file?.[3] ?? file?.[4];
      if (/^gh pr comment /.test(line) && path) {
        const { readFileSync } = await import("node:fs");
        bodies.push(readFileSync(path, "utf8"));
      }
      return { stdout: "https://example.test/pull/42\n" };
    }
    if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
    if (cmd.startsWith("git config --get remote.origin.url"))
      return { stdout: "https://github.com/o/r\n" };
    if (cmd.startsWith("git merge-base")) return { stdout: `${"1".repeat(40)}\n` };
    if (cmd.includes("git patch-id")) return { stdout: `${PATCH} (stdin)\n` };
    return { stdout: "" };
  };
  return { execFn };
}

const code = status();
console.log(`\nexit ${code}`);
process.exit(code);
