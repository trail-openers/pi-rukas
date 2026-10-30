#!/usr/bin/env bun
/**
 * #1920 slice B — `work-lean` writes a schema-5 result, and its three endings
 * are told apart by TYPED fields alone.
 *
 * The gap this closes is lean's own: `review`, `ci` and `land` are not built, so
 * every run that reaches `publish` exits 10. Exit 10 therefore covers a green PR
 * waiting for a merge, a draft behind unverified bytes, and a run that opened
 * nothing — and the pre-#1920 document separated none of them (`state` was
 * `handed-back` in all three cases, and the difference lived in `summary` prose).
 *
 * The three cases below are driven through the SAME fixture the verb's own tests
 * use, and each is distinguished by `prState`, `status` and `cap` ALONE — which
 * is what the issue asks for, and why the assertions read no other field. Usage
 * is asserted against the sum of the step log's own dispatch rows, so the cost a
 * host compares between the two engines is the cost the run's children reported.
 *
 * The other half of the contract the same fixture drives lives in
 * `test-headless-work-lean-delivery.ts`: that a field is reported ONLY when the
 * run observed it — a budget breach gets `failure.kind: "timeout"` and NO cap, a
 * handoff whose comment the forge refused says it was not delivered, and
 * `labelApplied` is false on every path.
 */

import { runWorkLeanVerb } from "../src/headless/work-lean.ts";
import type { LeanRun } from "../src/lean/state.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import { CHILDREN, HEAD, URL, driveLean, leanLog, stepWith, withReason } from "./lib/lean-result-fixture.ts";
import { REPO, fakeRun, verbRun } from "./lib/work-lean-verb-fixture.ts";

const { assert, state } = makeAssert();

const drive = driveLean;
const log = leanLog;


// ── (1) a green run with a READY PR: publish said `draft: false`, verify green.
{
  const r = await drive("handed-back", 10, log({ prUrl: URL, draft: false, dispatches: CHILDREN }));
  assert(r.violations.length === 0, `ready: output contract (${r.violations.join("; ")})`);
  assert(r.doc.schemaVersion === 5, `ready: schemaVersion 5 (got ${String(r.doc.schemaVersion)})`);
  assert(Array.isArray(r.doc.issues) && r.doc.issues.length === 1, "ready: exactly one issue");
  const i = r.issue ?? {};
  assert(i.issue === 7, "ready: the issue asked for");
  assert(i.prState === "ready", `ready: prState ready (got ${String(i.prState)})`);
  assert(i.status === "handoff", `ready: status handoff (got ${String(i.status)})`);
  assert(
    i.cap === "awaiting-human-merge",
    `ready: cap awaiting-human-merge (got ${String(i.cap)})`,
  );
  assert(i.prUrl === URL, `ready: prUrl (got ${String(i.prUrl)})`);
  assert(i.branch === "feature/issue-7-thing", `ready: branch (got ${String(i.branch)})`);
  assert(i.exitCode === 10, `ready: exitCode 10 (got ${String(i.exitCode)})`);
  // usage is the SUM of the step rows, in total and per role.
  const usage = i.usage as Record<string, unknown>;
  assert(
    usage.input === 350 && usage.output === 35 && usage.dispatches === 3,
    `ready: usage sums the step rows (got ${JSON.stringify(usage)})`,
  );
  const byRole = usage.byRole as Record<string, Record<string, number>>;
  assert(
    byRole.developer?.input === 250 && byRole.developer?.dispatches === 2,
    `ready: byRole sums per role (got ${JSON.stringify(byRole.developer)})`,
  );
  assert(
    byRole.explore?.input === 100 && byRole.explore?.turns === 2,
    `ready: byRole carries the explore child (got ${JSON.stringify(byRole.explore)})`,
  );
  const handoff = i.handoff as Record<string, unknown> | undefined;
  assert(
    typeof handoff?.body === "string" && handoff.body.includes("handback comment posted"),
    `ready: the handoff body is the run's own record (got ${JSON.stringify(handoff?.body)})`,
  );
}

// ── (2) a DRAFT PR: publish recorded the forge left it a draft, so NO cap —
// a draft is not work waiting on a merge, and the draft state itself is what
// tells the story (`failure` is absent here on purpose: this log's gate went
// green and publish chose to open a draft, which `prState` alone says).
{
  const r = await drive("handed-back", 10, log({ prUrl: URL, draft: true, dispatches: CHILDREN }));
  assert(r.violations.length === 0, `draft: output contract (${r.violations.join("; ")})`);
  const i = r.issue ?? {};
  assert(i.prState === "draft", `draft: prState draft (got ${String(i.prState)})`);
  assert(i.status === "handoff", `draft: status handoff (got ${String(i.status)})`);
  assert(i.cap === undefined, `draft: no awaiting-human-merge for a draft (got ${String(i.cap)})`);
  assert(i.prUrl === URL, "draft: a draft is still a PR with an address");
  assert(
    i.failure === undefined,
    `draft: nothing failed — the draft state is the whole story (got ${JSON.stringify(i.failure)})`,
  );
  assert(
    JSON.stringify([i.prState, i.status, i.cap]) === JSON.stringify(["draft", "handoff", undefined]),
    `draft: told apart from the other two endings by prState/status/cap alone`,
  );
}

// ── (2b) the gate was RED and publish still opened a NON-draft PR: the forge
// says ready, the run's own gate does not. `awaiting-human-merge` tells a host
// to merge bytes its frozen tests called red, so the cap is the one field this
// case must not produce.
{
  const r = await drive(
    "handed-back",
    10,
    log({ prUrl: URL, draft: false, verify: "red", dispatches: CHILDREN }),
  );
  assert(r.violations.length === 0, `red-publish: output contract (${r.violations.join("; ")})`);
  const i = r.issue ?? {};
  assert(i.prState === "draft", `red-publish: not ready (got ${String(i.prState)})`);
  assert(i.status === "handoff", `red-publish: status handoff (got ${String(i.status)})`);
  assert(
    i.cap === undefined,
    `red-publish: no awaiting-human-merge over a red gate (got ${String(i.cap)})`,
  );
  assert(i.prUrl === URL, "red-publish: the PR exists, so its address is still reported");
  const failure = i.failure as Record<string, unknown>;
  assert(
    failure?.kind === "verify",
    `red-publish: failure carries the gate's verdict (got ${JSON.stringify(failure)})`,
  );
}

// ── (2c) `ready` also needs the green to be about the head publish shipped: a
// green whose `verifiedHead` is not the `publishedHead` the step recorded is a
// verdict about a different commit, exactly the case publish itself refuses to
// push over. The drift is typed on both sides — no prose involved.
{
  const r = await drive(
    "handed-back",
    10,
    log({ prUrl: URL, draft: false, dispatches: CHILDREN, publishedHead: "b".repeat(12) }),
  );
  assert(r.violations.length === 0, `drift: output contract (${r.violations.join("; ")})`);
  const i = r.issue ?? {};
  assert(
    i.prState === "draft",
    `drift: a green about another head is not ready (got ${String(i.prState)})`,
  );
  assert(i.cap === undefined, `drift: and no awaiting-human-merge (got ${String(i.cap)})`);
}

// ── (2d) a publish that recorded no head at all cannot be checked against the
// green, so the claim is unobserved and goes to the safe side. This is the case
// the typed `publishedHead` exists for: before it the head lived only in the
// reason line, so "a publish that named no head" was a prose question.
{
  const r = await drive(
    "handed-back",
    10,
    log({ prUrl: URL, draft: false, dispatches: CHILDREN, withPublishedHead: false }),
  );
  const i = r.issue ?? {};
  assert(
    i.prState === "draft",
    `no-head: a publish that named no head is not ready (got ${String(i.prState)})`,
  );
  assert(i.cap === undefined, `no-head: and no cap (got ${String(i.cap)})`);
}

// ── (2e) the head is TYPED, not prose: a reason line naming the very head the
// gate cleared is not evidence when the step recorded no `publishedHead`, so the
// result still says draft. This is the case that fails the moment anyone reads
// the reason line back.
{
  const steps = log({ prUrl: URL, draft: false, dispatches: CHILDREN, withPublishedHead: false });
  const prose = steps.map((s) => (s.state === "publish" ? withReason(s, `published PR ${URL} at ${HEAD.slice(0, 12)}`) : s));
  const r = await drive("handed-back", 10, prose);
  const i = r.issue ?? {};
  assert(
    i.prState === "draft",
    `prose-head: a reason line is not a published head (got ${String(i.prState)})`,
  );
  assert(i.cap === undefined, `prose-head: and no cap (got ${String(i.cap)})`);
}

// ── (3) NO PR: the run handed back before any publish step decided.
{
  const r = await drive("handed-back", 10, log({ dispatches: CHILDREN, verify: "red" }));
  assert(r.violations.length === 0, `no-pr: output contract (${r.violations.join("; ")})`);
  const i = r.issue ?? {};
  assert(i.prState === "none", `no-pr: prState none (got ${String(i.prState)})`);
  assert(i.status === "handoff", `no-pr: status handoff (got ${String(i.status)})`);
  assert(i.cap === undefined, `no-pr: no cap to publish (got ${String(i.cap)})`);
  assert(i.prUrl === undefined, "no-pr: no address");
  const failure = i.failure as Record<string, unknown>;
  assert(
    failure?.kind === "verify" && String(failure.message).includes("red"),
    `no-pr: the gate's red verdict is the failure (got ${JSON.stringify(failure)})`,
  );
  const usage = i.usage as Record<string, unknown>;
  assert(usage.dispatches === 3, `no-pr: usage still counts the children (got ${usage.dispatches})`);
}

// ── (3b) the three endings are pairwise distinct on those three fields alone.
{
  const seen = new Set<string>();
  for (const [label, steps] of [
    ["ready", log({ prUrl: URL, draft: false })],
    ["draft", log({ prUrl: URL, draft: true })],
    ["none", log({})],
  ] as const) {
    const i = (await drive("handed-back", 10, steps)).issue ?? {};
    const key = JSON.stringify([i.prState, i.status, i.cap]);
    assert(!seen.has(key), `${label}: its [prState,status,cap] triple is its own (${key})`);
    seen.add(key);
  }
  assert(seen.size === 3, `three endings, three distinct triples (got ${seen.size})`);
}

// ── (4) an unobserved draft state is `draft`, the safe side: a publish outcome
// with no `draft` field is the one case where nobody knows, and `ready` would
// tell a host to merge bytes the run's gate never cleared.
{
  const r = await drive("handed-back", 10, log({ prUrl: URL, dispatches: CHILDREN }));
  const i = r.issue ?? {};
  assert(
    i.prState === "draft",
    `a publish that recorded no draft state is the safe answer (got ${String(i.prState)})`,
  );
}

// ── (5) a run that MERGED is the document's own success: status merged, no cap,
// and no PR awaiting anything.
{
  const r = await drive("landed", 0, [
    stepWith("ready", { kind: "ok", dispatches: CHILDREN }),
    stepWith("verify", { kind: "green", verifiedHead: HEAD }),
    stepWith("publish", {
      kind: "ok",
      prUrl: URL,
      draft: false,
      publishedHead: HEAD,
      reason: `published PR ${URL} at ${HEAD.slice(0, 12)}`,
    }),
    stepWith("ci", { kind: "green" }),
    stepWith("land", { kind: "merged" }),
  ]);
  const i = r.issue ?? {};
  assert(r.code === 0, `landed exits 0 through the verb (got ${r.code})`);
  assert(i.status === "merged", `landed: status merged (got ${String(i.status)})`);
  assert(i.cap === undefined, `landed: no cap (got ${String(i.cap)})`);
  assert(i.failure === undefined, "landed: nothing failed");
  assert(i.prState === "ready", `landed: the PR it merged was ready (got ${String(i.prState)})`);
}

// ── (6) a REFUSED issue keeps its own code and document, untouched by #1920:
// the projection is for the run that answered, not for a bad argv.
{
  const r = await verbRun(["abc"], async () => ({
    summary: "should not run",
    result: fakeRun({ code: 0, state: "landed" }),
  }));
  assert(r.code === 40, `bad argv still exits 40 (got ${r.code})`);
  assert(
    (r.doc.error as { code?: string })?.code === "bad-arguments",
    "bad argv still reports bad-arguments",
  );
  assert(r.doc.schemaVersion === undefined, "a refusal writes no schema-5 document");
  assert(r.doc.issues === undefined, "a refusal projects no issue");
}

// ── (7) the branch is `specifyBranch`'s answer, including its fallback: a run
// seeded with no branch still names the branch its steps worked on.
{
  const noBranch: LeanRun = {
    schema: 1,
    issue: 7,
    version: "0.0.0-test",
    models: {},
    baseSha: "feedbeef1234567890feedbeef1234567890abcd",
    branch: "   ",
    state: "handed-back",
    counters: {
      buildAttempts: 1,
      challengeDone: true,
      reviewDone: false,
      ciFixUsed: false,
      draft: false,
    },
    steps: log({ prUrl: URL, draft: false }),
    result: { code: 10, reason: "x" },
  };
  const out = await runWorkLeanVerb(
    ["7"],
    { repoRoot: REPO, host: { sendUserMessage: () => {}, emit: () => {} } },
    async () => ({
      summary: "s",
      result: { code: 10, state: "handed-back", run: noBranch },
    }),
  );
  // Read off the document the VERB wrote, not a re-projection: this case is about
  // what a host actually receives when the run was seeded with no branch.
  const issues = out.doc.issues as Record<string, unknown>[] | undefined;
  const i = Array.isArray(issues) ? (issues[0] ?? {}) : {};
  assert(
    i.branch === "lean/issue-7",
    `a run with no branch still names one (got ${String(i.branch)})`,
  );
}

process.exit(state.exit);
