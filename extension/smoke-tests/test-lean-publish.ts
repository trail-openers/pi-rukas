#!/usr/bin/env bun
/**
 * lean/publish + lean/publish-body + lean/text-fence — the step that writes
 * outside the clone.
 *
 * The repo, the branch and the origin are real (lib/lean-publish-fixture.ts: a
 * bare repo on disk that `git push` actually writes into), and only the forge is
 * a recorder. So the assertions below are about the ref origin holds and the
 * calls the forge actually received, not about what a stub claimed.
 *
 *   (a) a green verify at HEAD, two test criteria -> pushed, PR opened ready,
 *       both ids and both test paths in the body, prUrl recorded
 *   (b) a manual criterion -> draft
 *   (c) no green verify + the draft counter -> draft, and the body says so
 *   (d) an open PR already on the branch -> reused, prCreate never called
 *   (e) prList throws -> PublishInfraError, and NO prCreate (never a duplicate)
 *   (f) the green verdict is about another commit -> throw BEFORE the push,
 *       origin untouched, no prCreate
 *   (g) a dirty tree -> throw
 *   (h) origin holds a foreign commit on the branch -> throw, no prCreate
 *   (i) an injected heading in a criterion and in the verify reason -> neither
 *       becomes a heading of the body; the reason sits inside the ```text fence
 *   (j) handback: a reason with a heading stays fenced, and an unsafe branch
 *       prints no Branch line at all
 *   (k) wiring: phase1Handlers.publish is the step, not the notBuilt stub
 *   (l) a state file whose branch is `main`, or `refs/heads/lean/x` -> throw
 *       BEFORE the push; origin's main unchanged, no prCreate
 *   (m) a reused PR that reports itself READY while this run is not green ->
 *       prDraft is called; when prDraft fails the step throws rather than
 *       leaving a ready PR over unverified work
 *   (n) the push runs with a non-interactive git env (no terminal / ssh prompt)
 *
 * What ORIGIN's ref decides — the conditional force, the lease, and the open-PR
 * refusal — is `test-lean-publish-remote.ts` (cases h and o-s there): same
 * fixture, same recorder, split so neither file crosses the size cap.
 *
 * The PR-body RENDERER (`lean/publish-body`) has its own file,
 * `test-lean-publish-body.ts`; the cases here that read a body assert only what
 * the step's own record decides — which head a green may print, which rows a
 * verdict colours — against the same fixture.
 */

import { handbackOutcome } from "../src/lean/handback.ts";
import { PublishInfraError } from "../src/lean/publish-deps.ts";
import type { PiSpec } from "../src/lean/spec.ts";
import { fakePr } from "./lib/lean-publish-forge.ts";
import { ROOTS, defaultSpec, originHead, runPublish } from "./lib/lean-publish-fixture.ts";
import { decided, handbackCtx } from "./lib/lean-verify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Body lines, for the assertions that must be about a LINE, not a substring. */
function lines(body: string): string[] {
  return body.split("\n");
}

/**
 * The line an injected heading must NOT become.
 *
 * Inside a ` ```text ` fence a `### INJ` is inert — it renders as a line of a
 * code block, which is the guarantee `fenceText` exists to give, and asserting
 * its absence line-by-line would demand the opposite of what the fence means.
 * What the step must refuse is the heading appearing UNFENCED: standing on its
 * own in the document, it becomes a section of the comment a reader trusts.
 */
function unfenced(ls: string[], heading: string): boolean {
  let open = false;
  for (const l of ls) {
    if (/^```/.test(l)) {
      open = !open;
      continue;
    }
    if (!open && l === heading) return true;
  }
  return false;
}

// ------------------------------------------------- (a) green verify -> pushed, PR opened
{
  const r = await runPublish({ issue: 401, verify: { kind: "green" } });
  assert(
    r.outcome?.kind === "ok",
    `(a) a green verify at HEAD publishes (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    originHead(r.origin, "lean/issue-401") === r.head,
    `(a) origin's branch points at the verified head (${originHead(r.origin, "lean/issue-401")})`,
  );
  assert(r.forge.prCreateCalls.length === 1, "(a) prCreate was called exactly once");
  assert(r.forge.prCreateCalls[0]?.draft === false, "(a) the PR is opened ready, not draft");
  assert(
    r.forge.prCreateCalls[0]?.head === "lean/issue-401",
    "(a) prCreate was told the run's branch",
  );
  assert(
    (r.forge.prCreateCalls[0]?.body.includes("AC1") ?? false) &&
      (r.forge.prCreateCalls[0]?.body.includes("AC2") ?? false),
    "(a) the body names both criterion ids",
  );
  assert(
    (r.forge.prCreateCalls[0]?.body.includes("`tests/AC1-retry.test.sh`") ?? false) &&
      (r.forge.prCreateCalls[0]?.body.includes("`tests/AC2-bound.test.sh`") ?? false),
    "(a) the body names each criterion's test path",
  );
  assert(
    typeof r.outcome?.prUrl === "string" && r.outcome.prUrl.startsWith("https://"),
    `(a) the outcome records the PR url (${r.outcome?.prUrl})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("published PR") &&
      (r.outcome?.reason ?? "").includes(r.head.slice(0, 12)),
    "(a) the reason names the publish and the head",
  );
  assert(
    r.body.includes("| AC1 |") && r.body.includes("green"),
    "(a) both rows carry the green result",
  );
}

// ------------------------------------------------------------- (b) manual -> draft
{
  const spec: PiSpec = {
    ...defaultSpec(),
    criteria: [
      { id: "AC1", text: "a transient failure is retried", verify: "test" },
      { id: "AC2", text: "the operator confirms the alert", verify: "manual" },
    ],
  };
  const r = await runPublish({ issue: 402, verify: { kind: "green" }, spec });
  assert(r.forge.prCreateCalls[0]?.draft === true, "(b) a manual criterion opens the PR as draft");
  assert(r.body.includes("manual — needs a human"), "(b) the manual row says a human is needed");
  assert(
    originHead(r.origin, "lean/issue-402") === r.head,
    "(b) a draft is still pushed — the work is on the branch either way",
  );
}

// ------------------------------------- (c) no green verify + the draft counter -> draft
{
  const r = await runPublish({ issue: 403, draft: true });
  assert(
    r.outcome?.kind === "ok",
    `(c) a run with no verdict still publishes (got ${r.threw?.message})`,
  );
  assert(r.forge.prCreateCalls[0]?.draft === true, "(c) the PR is a draft");
  assert(r.body.includes("not verified (draft)"), "(c) the body says the head is not verified");
  assert(
    r.body.includes("not run"),
    "(c) with no verdict every row reads not run rather than green",
  );
}

// ------------------------------------------- (d) an open PR on the branch -> reuse it
{
  const existing = fakePr(9, "https://forge.example/pull/9", "lean/issue-404");
  const r = await runPublish({ issue: 404, verify: { kind: "green" }, openPrs: [existing] });
  assert(
    r.forge.prCreateCalls.length === 0,
    `(d) an open PR on the branch is reused, not duplicated (${r.forge.prCreateCalls.length} creates)`,
  );
  assert(
    r.outcome?.prUrl === "https://forge.example/pull/9",
    "(d) the existing PR's url is recorded",
  );
  assert(r.forge.prListCalls === 1, "(d) the forge was asked before it was told");
}

// ------------------------------------------------- (e) prList throws -> no duplicate
{
  const r = await runPublish({ issue: 405, verify: { kind: "green" }, listThrows: true });
  assert(
    r.threw instanceof PublishInfraError,
    `(e) a forge that cannot list is infrastructure (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(r.forge.prCreateCalls.length === 0, "(e) nothing was created on a list that failed");
  assert(
    originHead(r.origin, "lean/issue-405") === r.head,
    "(e) the branch is still pushed — the refusal is about the PR, not the push",
  );
}

// ----------------------------- (f) the green verdict is about a different commit
{
  const r = await runPublish({
    issue: 406,
    verify: { kind: "green" },
    commitAfterVerify: true,
    noPush: true,
  });
  assert(
    r.threw instanceof PublishInfraError && /HEAD moved/.test(r.threw.message),
    `(f) a green that is not about this head is refused (got ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-406") === "",
    `(f) nothing was pushed — the refusal happens BEFORE the push (${originHead(r.origin, "lean/issue-406")})`,
  );
  assert(r.forge.prCreateCalls.length === 0, "(f) no PR was opened for an unverified head");
}

// ------------------------------------------------------------- (g) a dirty tree
{
  const r = await runPublish({ issue: 407, verify: { kind: "green" }, dirty: true, noPush: true });
  assert(
    r.threw instanceof PublishInfraError && /not clean/.test(r.threw.message),
    `(g) uncommitted bytes are refused (got ${r.threw?.message})`,
  );
  assert(originHead(r.origin, "lean/issue-407") === "", "(g) a dirty tree is not pushed");
  assert(r.forge.prCreateCalls.length === 0, "(g) a dirty tree opens no PR");
}

// ------------------------------------------------------ (i) injection into the body
{
  const spec: PiSpec = {
    ...defaultSpec(),
    criteria: [
      { id: "AC1", text: "x\n### INJ", verify: "test" },
      { id: "AC2", text: "the backoff is bounded", verify: "test" },
    ],
  };
  const r = await runPublish({
    issue: 409,
    verify: { kind: "green", reason: "```\n### INJ2" },
    spec,
  });
  const body = r.body;
  assert(
    !unfenced(lines(body), "### INJ"),
    "(i) an injected heading in a criterion never stands unfenced in the body",
  );
  assert(
    !unfenced(lines(body), "### INJ2"),
    "(i) an injected heading in the verify reason never stands unfenced in the body",
  );
  const fence = lines(body).findIndex((l) => l === "```text");
  assert(fence >= 0, "(i) the verify reason is inside a ```text fence");
  assert(
    fence >= 0 &&
      lines(body)
        .slice(fence)
        .some((l) => l.includes("INJ2")),
    "(i) the reason's content is inside the fence, not outside it",
  );
  assert(
    lines(body).filter((l) => l.trim() === "```").length === 1,
    "(i) exactly one bare closing fence appears — the payload supplied none",
  );
}

// -------------------------------------------------------- (j) handback fences its text
{
  const posts: string[] = [];
  const post = async (_r: string, _i: number, body: string) => {
    posts.push(body);
  };
  await handbackOutcome(
    handbackCtx(410, [
      decided("ready", { kind: "ok" }),
      decided("verify", { kind: "red", reason: "a\n### FAKE" }),
    ]),
    post,
  );
  const body = posts[0] ?? "";
  assert(
    !unfenced(lines(body), "### FAKE"),
    "(j) a handback reason's heading never stands unfenced in the comment",
  );
  assert(
    body.includes("```text") && body.includes("### FAKE"),
    "(j) the reason is printed, but as fenced text",
  );

  const posts2: string[] = [];
  const post2 = async (_r: string, _i: number, b: string) => {
    posts2.push(b);
  };
  const ctx = handbackCtx(411, [decided("verify", { kind: "red", reason: "why" })]);
  ctx.run = { ...ctx.run, branch: "lean/i\n### X" };
  await handbackOutcome(ctx, post2);
  assert(
    !(posts2[0] ?? "").includes("Branch:"),
    "(j) a branch that is not a safe ref prints no Branch line at all",
  );
}

// --------------------------- (l) a state file naming the mainline is refused
//
// `run.branch` is persisted state, not a name this cycle chose, so a run whose
// state says `main` must never reach the push. Rule 1 (the `lean/` prefix) is
// what refuses both shapes here; the second case shows a `refs/heads/` prefix
// cannot smuggle a branch past it either.
for (const [issue, branch] of [
  [413, "main"],
  [414, "refs/heads/lean/x"],
] as const) {
  // The tree is checked out on a real lean ref, so the only thing that makes
  // this run dangerous is the branch its state file names — which is exactly
  // the field under test. `leanRef` is the branch a legitimate run would have
  // pushed, and stays empty for both cases: origin holds only the base commit
  // on `main` (the fixture pushes it), so nothing else on origin moved.
  const leanRef = `lean/issue-${issue}`;
  const r = await runPublish({
    issue,
    verify: { kind: "green" },
    branch,
    worktreeBranch: leanRef,
    noPush: true,
  });
  assert(
    r.threw instanceof PublishInfraError,
    `(l) a run on ${JSON.stringify(branch)} throws PublishInfraError (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    /work-lean pushes only lean\/ branches/.test(r.threw?.message ?? ""),
    `(l) ${JSON.stringify(branch)} is refused by the lean/ rule (${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "main") !== "" && originHead(r.origin, "main") !== r.head,
    `(l) origin's main still holds the base commit — nothing was pushed to it (${originHead(r.origin, "main")})`,
  );
  assert(
    originHead(r.origin, leanRef) === "",
    `(l) nothing was pushed to ${JSON.stringify(branch)} (${originHead(r.origin, leanRef)})`,
  );
  assert(r.forge.prCreateCalls.length === 0, `(l) ${JSON.stringify(branch)} opens no PR`);
}

// ------------------------------- (m) a reused READY PR is put back to draft
//
// `prCreate`'s `draft` option only applies to a PR this step OPENS, so a reused
// PR keeps the state the previous run left it in. A not-green run that reuses a
// ready PR must re-draft it (or refuse) — never leave a mergeable PR attached to
// a head nothing verified.
{
  const ready = fakePr(90, "https://forge.example/pull/90", "lean/issue-415", false);
  const r = await runPublish({ issue: 415, verify: { kind: "red" }, openPrs: [ready] });
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
}

// A PR already marked draft needs nothing done to it.
{
  const draftPr = fakePr(91, "https://forge.example/pull/91", "lean/issue-416", true);
  const r = await runPublish({ issue: 416, verify: { kind: "red" }, openPrs: [draftPr] });
  assert(
    r.forge.prDraftCalls.length === 0,
    `(m) a reused PR already in draft is left alone (${JSON.stringify(r.forge.prDraftCalls)})`,
  );
}

// A green run reuses a ready PR untouched — the PR is verified work.
{
  const ready = fakePr(92, "https://forge.example/pull/92", "lean/issue-417", false);
  const r = await runPublish({ issue: 417, verify: { kind: "green" }, openPrs: [ready] });
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

// `gh pr list --json` carries no isDraft, so the step asks `prView` — and a
// forge that answers neither is a refusal, never a guess of "already a draft".
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
    `(m) a draft state nobody could read is refused (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    r.forge.prViewCalls.length === 1 && r.forge.prViewCalls[0] === 94,
    `(m) the forge was asked before it was guessed at (${JSON.stringify(r.forge.prViewCalls)})`,
  );
  assert(
    r.forge.prDraftCalls.length === 0,
    "(m) nothing was drafted on a state the step could not read",
  );
}

// ----------------------------------------------------------- (k) the wiring is real
{
  const { phase1Handlers } = await import("../src/lean/command.ts");
  const handler = phase1Handlers("/nonexistent", 412).publish;
  let message = "no publish handler";
  if (handler) {
    message = await handler({
      repoRoot: "/nonexistent",
      issue: 412,
      run: { branch: "", counters: { draft: false } },
      steps: [],
      stepKey: "412:publish:0",
      now: () => 1,
    } as never).then(
      (o) => `returned ${JSON.stringify(o)}`,
      (e: unknown) => (e as Error).message,
    );
  }
  assert(
    !/not built yet/.test(message),
    `(k) phase1Handlers.publish is the step, not the stub (${message})`,
  );
  assert(
    /does not exist/.test(message),
    "(k) the real step ran far enough to look for the worktree and refuse",
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
