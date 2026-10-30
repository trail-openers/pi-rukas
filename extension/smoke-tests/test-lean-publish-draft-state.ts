#!/usr/bin/env bun
/**
 * lean/publish — the DRAFT STATE a run records, and nothing else.
 *
 * Split out of `test-lean-publish.ts` for the §12 size cap along the seam those
 * cases already formed: every one of them is about how a `draft` reaches the
 * record, not about the push or the body around it. The rule they share is that
 * the record carries what the FORGE was READ to say, never what this run asked
 * for — `gh pr create --json` and `gh pr list --json` both omit `isDraft`, so a
 * step that did not ask could only guess, and a guessed `true` over a ready PR
 * tells the host a mergeable PR stands behind unverified bytes.
 *
 *   (m) a reused PR left READY by the previous run is put back to draft by a
 *       not-green run, and the record says draft only after reading it back
 *   (m) a reused PR already in draft is left alone
 *   (m) a green run does not draft its own verified PR
 *   (m) a `prDraft` that fails is infrastructure, never a silently-ready PR
 *   (m) a draft state the forge will not say is REFUSED on a run that needs it
 *   (m) a draft state no reply was asked for is omitted, never copied from the
 *       state this run wanted
 *   (m) a CREATED draft the forge reports ready is recorded ready
 *   (m) a created PR whose state nobody could read records no `draft` at all
 *
 * The push and remote cases live in `test-lean-publish-remote.ts`, the body
 * cases in `test-lean-publish-body.ts`, the draft-GATE cases (whether a run is
 * a draft at all) in `test-lean-publish-draft-gate.ts`.
 */

import { PublishInfraError } from "../src/lean/publish-deps.ts";
import { fakePr } from "./lib/lean-publish-forge.ts";
import { ROOTS, originHead, runPublish } from "./lib/lean-publish-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------- (m) a reused READY PR is put back to draft
//
// `prCreate`'s `draft` option only applies to a PR this step OPENS, so a reused
// PR keeps the state the previous run left it in. A not-green run that reuses a
// ready PR must re-draft it (or refuse) — never leave a mergeable PR attached to
// a head nothing verified.
{
  const ready = fakePr(90, "https://forge.example/pull/90", "lean/issue-415", false);
  const r = await runPublish({
    issue: 415,
    verify: { kind: "red" },
    openPrs: [ready],
    viewIsDraft: { "90": false },
  });
  assert(
    r.outcome?.kind === "ok",
    `(m) a not-green run over a reused PR still publishes (got ${r.threw?.message})`,
  );
  assert(
    r.forge.prDraftCalls.length === 1 && r.forge.prDraftCalls[0] === 90,
    `(m) the reused ready PR is put back to draft (${JSON.stringify(r.forge.prDraftCalls)})`,
  );
  assert(
    originHead(r.origin, "lean/issue-415") === r.head,
    "(m) the work is pushed, but only behind a draft",
  );
  assert(
    r.outcome?.draft === true,
    `(m) the outcome records the PR as a draft after the re-draft (got ${String(r.outcome?.draft)})`,
  );
}

// A PR already marked draft needs nothing done to it.
{
  const draftPr = fakePr(91, "https://forge.example/pull/91", "lean/issue-416", true);
  const r = await runPublish({
    issue: 416,
    verify: { kind: "red" },
    openPrs: [draftPr],
    viewIsDraft: { "91": true },
  });
  assert(
    r.forge.prDraftCalls.length === 0,
    `(m) a reused PR already in draft is left alone (${JSON.stringify(r.forge.prDraftCalls)})`,
  );
}

// A green run reuses a ready PR untouched — the PR is verified work.
{
  const ready = fakePr(92, "https://forge.example/pull/92", "lean/issue-417", false);
  const r = await runPublish({
    issue: 417,
    verify: { kind: "green" },
    openPrs: [ready],
    viewIsDraft: { "92": false },
  });
  assert(
    r.outcome?.kind === "ok" && r.forge.prDraftCalls.length === 0,
    `(m) a green run does not draft its own verified PR (${r.forge.prDraftCalls.length} drafts, ${r.threw?.message})`,
  );
}

// The forge refuses the re-draft: the step throws rather than leaving it ready.
{
  const ready = fakePr(93, "https://forge.example/pull/93", "lean/issue-418", false);
  const r = await runPublish({
    issue: 418,
    verify: { kind: "red" },
    openPrs: [ready],
    viewIsDraft: { "93": false },
    draftThrows: true,
  });
  assert(
    r.threw instanceof PublishInfraError && /back to draft/.test(r.threw.message),
    `(m) a prDraft that fails is infrastructure, not a silent ready PR (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    r.outcome === undefined,
    "(m) no ok outcome is recorded for a PR left ready over unverified work",
  );
}

// `gh pr list --json` carries no `isDraft`, so the state comes from `prView` —
// and on a run that must ACT on it (a not-green run deciding whether to re-draft)
// a forge that answers neither is a refusal, never a guess of "already a draft".
// Guessing "draft" is the direction that leaves a ready PR mergeable, and
// guessing "ready" drafts a PR that was already a draft: both are observations
// the step did not make.
{
  const unknown = fakePr(94, "https://forge.example/pull/94", "lean/issue-419", undefined);
  const r = await runPublish({
    issue: 419,
    verify: { kind: "red" },
    openPrs: [unknown],
    viewThrows: true,
  });
  assert(
    r.threw instanceof PublishInfraError && /could not tell whether/.test(r.threw.message),
    `(m) a draft state a run needed and nobody could read is refused (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    r.forge.prDraftCalls.length === 0,
    "(m) nothing was drafted on a state the step could not read",
  );
  // The other half of the rule, and the reason the refusal above is a rule and
  // not a veto: a run with NOTHING to decide (a green verdict drafts nothing) may
  // publish over a PR whose state it could not read — it is not about to leave a
  // mergeable PR standing over unverified bytes, so the unread state costs the run
  // the `draft` field and not the run. "Could not tell" is recorded as the
  // ABSENCE of the field; the state this run wanted never stands in for it.
  const unreadable = await runPublish({
    issue: 419,
    verify: { kind: "green" },
    openPrs: [fakePr(94, "https://forge.example/pull/94", "lean/issue-419", undefined)],
    viewThrows: true,
  });
  assert(
    unreadable.threw === undefined &&
      unreadable.outcome?.kind === "ok" &&
      !Object.hasOwn(unreadable.outcome, "draft"),
    `(m) a state the run did not need to act on is omitted, not guessed (got ${JSON.stringify(unreadable.outcome?.draft)}, ${unreadable.threw?.message})`,
  );
}

// ------------------------------------ (m) a CREATED draft the forge reports ready
//
// `gh pr create --json` carries no `isDraft`, so what the step asked for is not
// evidence of what the forge did. The step reads the new PR back; when the forge
// says `isDraft: false` over a requested draft, the record must say false — a
// recorded `true` would tell the host a mergeable PR stands behind unverified
// bytes, which is the lie this read-back exists to prevent.
{
  const r = await runPublish({
    issue: 420,
    verify: { kind: "red" },
    afterCreate: { 77: false },
  });
  assert(r.threw === undefined, `(m) create path with a ready report: ${r.threw?.message}`);
  assert(
    r.forge.prCreateCalls.length === 1 && r.forge.prCreateCalls[0]?.draft === true,
    "(m) the step asked the forge for a draft",
  );
  assert(
    r.outcome?.draft === false,
    `(m) the recorded draft is what the forge REPORTS, not what was asked (got ${String(r.outcome?.draft)})`,
  );
}

// And when the read-back cannot answer at all, the record carries NO `draft`:
// "could not tell" is never recorded as the state this run wanted.
{
  const r = await runPublish({
    issue: 421,
    verify: { kind: "red" },
    afterCreate: { 77: undefined },
  });
  assert(r.threw === undefined, `(m) create path with no report: ${r.threw?.message}`);
  assert(
    r.forge.prCreateCalls[0]?.draft === true,
    "(m) the step still asked for a draft, and the PR is still pushed",
  );
  assert(
    r.outcome !== undefined && !Object.hasOwn(r.outcome, "draft"),
    `(m) a draft state nobody could read is omitted, not guessed (got ${JSON.stringify(r.outcome?.draft)})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
