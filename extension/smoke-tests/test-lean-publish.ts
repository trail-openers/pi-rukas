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
 */

import { handbackOutcome } from "../src/lean/handback.ts";
import { publishBody } from "../src/lean/publish-body.ts";
import { PublishInfraError } from "../src/lean/publish-deps.ts";
import type { PiSpec } from "../src/lean/spec.ts";
import { fenceText, oneLine } from "../src/lean/text-fence.ts";
import { ROOTS, defaultSpec, fakePr, originHead, runPublish } from "./lib/lean-publish-fixture.ts";
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
  const r = await runPublish({ issue: 407, verify: { kind: "green" }, dirty: true });
  assert(
    r.threw instanceof PublishInfraError && /not clean/.test(r.threw.message),
    `(g) uncommitted bytes are refused (got ${r.threw?.message})`,
  );
  assert(originHead(r.origin, "lean/issue-407") === "", "(g) a dirty tree is not pushed");
  assert(r.forge.prCreateCalls.length === 0, "(g) a dirty tree opens no PR");
}

// ------------------------------------- (h) origin holds a foreign commit -> no force
{
  const r = await runPublish({ issue: 408, verify: { kind: "green" }, originForeign: true });
  assert(
    r.threw instanceof PublishInfraError,
    `(h) a non-fast-forward push throws (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(r.forge.prCreateCalls.length === 0, "(h) a refused push opens no PR");
  assert(
    originHead(r.origin, "lean/issue-408") !== r.head,
    "(h) origin still holds the foreign commit — the step never forced over it",
  );
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

/**
 * A path the body prints: the brief's print filter, applied verbatim. No
 * whitespace (a space would sit inside a table cell), no shell or markdown
 * metacharacter, no newline that could end the row.
 */
const BODY_PATH = /^[A-Za-z0-9._/-]+$/;
function printable(p: string): boolean {
  return BODY_PATH.test(p);
}

// --------------------------------------------------- text-fence's own two guarantees
{
  assert(fenceText("a\nb", 100).startsWith("```text\n"), "fenceText opens a text fence");
  assert(
    fenceText("x".repeat(20), 5) === "```text\nxxxxx…\n```",
    "fenceText clips with an ellipsis",
  );
  assert(!fenceText("```` evil", 100).includes("````"), "fenceText neutralises a run of backticks");
  assert(oneLine("a\n### b\tc", 50) === "a ### b c", "oneLine flattens every control character");
  assert(oneLine("a|b", 50) === "a\\|b", "oneLine escapes a pipe so a row cannot gain a column");
  assert(oneLine("a".repeat(20), 5).endsWith("…"), "oneLine clips");
  const paths = ["ok/test-1.sh", "bad name;rm", "bad|pipe", "bad\ttab.sh"];
  const body = publishBody({
    issue: 1,
    spec: { problem: "p", size: "S", criteria: [{ id: "AC1", text: "t", verify: "command" }] },
    tests: { AC1: paths },
    verifyKind: "red",
    verifyReason: "tail",
    draft: true,
    version: "1.2.3",
    models: { developer: "m" },
    baseSha: "a".repeat(40),
  });
  assert(
    paths.filter((p) => !printable(p)).every((p) => !body.includes(p)),
    `publishBody drops every path carrying a character it may not print (${paths.filter((p) => !printable(p)).join(" | ")})`,
  );
  assert(
    paths.filter(printable).every((p) => body.includes(`\`${p}\``)),
    "publishBody prints every path it may print",
  );
  assert(body.includes("`ok/test-1.sh`"), "publishBody prints a well-formed path");

  const row = lines(body)[6] ?? "";
  assert(
    row.startsWith("| AC1 | t | command | `ok/test-1.sh`") && row.endsWith("| red |"),
    `publishBody renders the row in the promised column order (${JSON.stringify(row)})`,
  );
  assert(
    body.includes("- pi-rukas 1.2.3") && body.includes(`- base \`${"a".repeat(40)}\``),
    "publishBody stamps the version and the base sha",
  );
  assert(body.includes("- draft:"), "a draft body says why it is a draft");
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
