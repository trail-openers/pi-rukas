#!/usr/bin/env bun
/**
 * lean/publish — a run re-publishing to the PR ITSELF opened, after a red `ci` sent
 * it back through `build`.
 *
 * The field shape this exists for: `verify` green → `publish` (PR opened) → `review`
 * fixed → `verify` green → `publish` "already on origin" → `ci` red → `build` →
 * `verify` green → `publish` REFUSED. Origin holds the sha this run's own last publish
 * wrote, and the only row the forge lists for the branch is the PR that same publish
 * created. Before the fix the step read origin, saw a sha that was neither absent nor
 * its head, saw one unsettled row, and handed the run back at exit 10 — every time.
 *
 * Every case below runs against a real bare origin (`lib/lean-publish-fixture.ts`), so
 * "the push landed" is a fact about the ref origin holds afterwards and "it was
 * refused" is a fact about the ref NOT moving. The forge is the recorder
 * (`lib/lean-publish-forge.ts`), so a row's `url`, `state` and `headRefName` are the
 * values the step actually read.
 *
 *   (a) the field shape: origin at the run's own `publishedHead`, ONE row whose url is
 *       the recorded `prUrl`, head descending from it -> ok, origin now at head, the
 *       lease bound to the sha the step read, and NO second PR opened
 *   (c) origin moved by somebody else (not the recorded sha) -> refused
 *   (d) head does NOT descend from the recorded sha -> refused, origin unmoved
 *   (e) the row's url is not the recorded `prUrl` -> refused
 *   (f) the row is not the one `openPr` reuses (headRefName differs) -> refused
 *   (g) TWO unsettled rows -> refused: no single identity for "my own PR"
 *   (h) no decided publish at all (a first publish) -> refused
 *   (i) a publish record with no `publishedHead`, or a truncated one -> refused
 *   (j) GitLab's `"opened"` and GitHub's `"OPEN"` arrive at the same verdict
 *   (k) the ancestry read cannot answer (exit 128) -> `PublishInfraError`, not a refusal
 *   (l) a settled row beside the run's own row -> exempt: only UNSETTLED rows are counted
 *
 */

import { rmSync } from "node:fs";
import { PublishInfraError } from "../src/lean/publish-deps.ts";
import type { PublishDeps } from "../src/lean/publish-deps.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { ROOTS, originHead, runPublish } from "./lib/lean-publish-fixture.ts";
import { fakePr, prWithState } from "./lib/lean-publish-forge.ts";

const { assert, failures } = makeAssert();
const SELF = "test-lean-publish-republish-own-pr.ts";
const check = (cond: boolean, msg: string): void => assert(cond, `${SELF}: ${msg}`);

/** Run one publish with the switch pinned to `value`, and hand the result back. */
async function drive(opts: Parameters<typeof runPublish>[0]): Promise<
  Awaited<ReturnType<typeof runPublish>>
> {
  const out = await runPublish(opts);
  if (out === undefined) throw new Error("the drive produced no result");
  return out;
}

/** The URL a case's prior publish recorded, and the row that must match it. */
const OWN_URL = "https://forge.example/pull/55";
const ownRow = (branch: string, url = OWN_URL) => fakePr(55, url, branch);
const branchOf = (issue: number): string => `lean/issue-${issue}`;

// ------------------------- (a) the field shape: the run's own PR, its own sha -> push
{
  const issue = 901;
  const r = await drive({
    issue,
    verify: { kind: "green" },
    originStale: "own-publish",
    priorPublish: { prUrl: OWN_URL },
    openPrs: [ownRow(`lean/issue-${issue}`)],
  });
  const branch = r.branch;
  assert(
    /^[0-9a-f]{40}$/.test(r.priorHead ?? ""),
    `(a) the fixture planted a real prior head on origin (got ${JSON.stringify(r.priorHead)})`,
  );
  assert(
    r.priorHead !== r.head,
    "(a) the head about to be pushed is NEWER than what the run last published",
  );
  assert(
    r.outcome?.kind === "ok",
    `(a) the run's own PR does not block its own re-publish (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(originHead(r.origin, branch) === r.head, "(a) origin's branch now holds the new head");
  assert(
    r.leaseArg === `--force-with-lease=refs/heads/${branch}:${r.priorHead}`,
    `(a) the push stayed leased against the sha the step read, not the head (${JSON.stringify(r.leaseArg)})`,
  );
  // Reuse, never a second PR: `openPr` matched the row by head branch.
  assert(
    r.forge.prCreateCalls.length === 0,
    `(a) the existing PR was reused, not duplicated (${String(r.forge.prCreateCalls.length)} creates)`,
  );
  assert(
    r.outcome?.prUrl === OWN_URL,
    `(a) the record still names the run's own PR (got ${JSON.stringify(r.outcome?.prUrl)})`,
  );
  // The forge was still ASKED on the exempt arm: the identity is read, never assumed.
  assert(r.forge.prListCalls > 0, "(a) the exempt arm still asked the forge for the branch's rows");
}

// -------------------------- (c) origin moved by somebody else -> refused
//
// The recorded sha is the whole licence: if origin holds anything else the step is not
// looking at the branch it wrote, whatever the PR row says.
{
  const issue = 903;
  const r = await drive({
    issue,
    verify: { kind: "green" },
    // A foreign commit on the branch — origin is NOT at the run's recorded sha.
    originForeign: true,
    originStale: "own-publish",
    priorPublish: { prUrl: OWN_URL },
    openPrs: [ownRow(`lean/issue-${issue}`)],
  });
  const branch = r.branch;
  assert(
    r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
    `(c) a branch somebody else moved is refused even over the run's own PR (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(originHead(r.origin, branch) !== r.head, "(c) the foreign tip was not clobbered");
}

// ------------------- (d) the head does not descend from the recorded sha -> refused
//
// The exemption admits a FAST-FORWARD over this run's own history. A head that is not a
// descendant is a rewrite, and a rewrite needs the today-refusal.
{
  const issue = 904;
  const r = await drive({
    issue,
    verify: { kind: "green" },
    originStale: "own-publish",
    priorPublish: { prUrl: OWN_URL },
    openPrs: [ownRow(`lean/issue-${issue}`)],
    // A head sharing no ancestry with what the run published.
    graftForeignHead: true,
  });
  const branch = r.branch;
  assert(
    r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
    `(d) a head that is not a fast-forward over the recorded sha is refused (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(originHead(r.origin, branch) === r.priorHead, "(d) nothing was pushed");
}

// ------------------------ (e) the row's url is not the recorded prUrl -> refused
{
  const issue = 905;
  const r = await drive({
    issue,
    verify: { kind: "green" },
    originStale: "own-publish",
    priorPublish: { prUrl: OWN_URL },
    openPrs: [ownRow(`lean/issue-${issue}`, "https://forge.example/pull/999")],
  });
  const branch = r.branch;
  assert(
    r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
    `(e) a row whose url is not the run's recorded prUrl refuses (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(originHead(r.origin, branch) === r.priorHead, "(e) nothing was pushed");
}

// ------------- (f) the row is not the one `openPr` would reuse -> refused
//
// The exemption is scoped to the row the step goes on to reuse (`headRefName === branch`),
// so a row that would not be reused cannot be "the run's own PR".
{
  const issue = 906;
  const r = await drive({
    issue,
    verify: { kind: "green" },
    originStale: "own-publish",
    priorPublish: { prUrl: OWN_URL },
    openPrs: [ownRow(`lean/issue-${issue}- `)],
  });
  const branch = r.branch;
  assert(
    r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
    `(f) a row the step would not reuse refuses (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(originHead(r.origin, branch) === r.priorHead, "(f) nothing was pushed");
}

// ---------------------------------- (g) two unsettled rows -> no single "own" identity
{
  const issue = 907;
  const branch = branchOf(issue);
  const r = await drive({
    issue,
    verify: { kind: "green" },
    originStale: "own-publish",
    priorPublish: { prUrl: OWN_URL },
    openPrs: [ownRow(branch), fakePr(56, "https://forge.example/pull/56", branch)],
  });
  assert(
    r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
    `(g) two unsettled rows on the branch refuse (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(originHead(r.origin, branch) === r.priorHead, "(g) nothing was pushed");
}

// ---------------------------------- (h) no decided publish -> today's refusal
//
// A first publish has nothing to compare origin against. The write-ahead entry the
// engine writes before a step runs is NOT a record: it has no outcome.
{
  const issue = 908;
  const branch = branchOf(issue);
  const r = await drive({
    issue,
    verify: { kind: "green" },
    // A branch that is not absent and not the head, with NO decided publish in the log
    // — the first-publish shape, where there is no record to compare origin against.
    originStale: "stale-branch",
    openPrs: [ownRow(branch)],
  });
  assert(
    r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
    `(h) a run with no decided publish refuses as today (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(originHead(r.origin, branch) !== r.head, "(h) nothing was pushed");
}

// ------------- (i) a publish record missing or truncating `publishedHead` -> refused
{
  const issue = 909;
  const branch = branchOf(issue);
  for (const [label, outcome] of [
    ["no publishedHead", { kind: "ok", prUrl: OWN_URL }],
    ["a truncated publishedHead", { kind: "ok", prUrl: OWN_URL, publishedHead: "abc123" }],
  ] as const) {
    const r = await drive({
      issue,
      verify: { kind: "green" },
      originStale: "own-publish",
      priorPublish: { prUrl: OWN_URL },
      openPrs: [ownRow(branch)],
      // Overwrite the fixture's own record with the shape under test.
      overwritePublishOutcome: outcome,
    });
    assert(
      r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
      `(i) a publish record with ${label} refuses (got ${r.threw?.name}: ${r.threw?.message})`,
    );
  }
}

// --------------------- (j) GitLab's `opened` and GitHub's `OPEN` reach the same verdict
//
// The two adapters normalise differently (`mapGlMr` uppercases `opened`, `mapGhPr`
// receives gh's already-upper state), and the exemption compares only URL and head
// branch — never state — so both must land on the same answer.
for (const [label, state] of [
  ["GitLab", "opened"],
  ["GitHub", "OPEN"],
] as const) {
  const issue = label === "GitLab" ? 910 : 911;
  const branch = branchOf(issue);
  const r = await drive({
    issue,
    verify: { kind: "green" },
    originStale: "own-publish",
    priorPublish: { prUrl: OWN_URL },
    openPrs: [prWithState(55, OWN_URL, branch, state)],
  });
  assert(
    r.outcome?.kind === "ok",
    `(j) a row the ${label} adapter reports as ${JSON.stringify(state)} is exempt (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, branch) === r.head,
    `(j) ${label}: origin's branch now holds the new head`,
  );
}

// --------- (k) the ancestry read cannot answer -> infrastructure, never a quiet "no"
//
// git's exit 1 means "not a fast-forward" and refuses (case d). Exit 128 — a dead
// child, an unreadable tree, an unresolvable rev — means nobody answered, and silence
// is never a pass: the step reports infrastructure naming both shas.
{
  const issue = 912;
  const branch = branchOf(issue);
  let ancestryArgv: string[] | undefined;
  // A rejection carrying git's exit code — the shape `execp` reports a non-zero child.
  const deadAncestry = (): Promise<never> =>
    Promise.reject(Object.assign(new Error("git merge-base died"), { code: 128 }));
  const r = await drive({
    issue,
    verify: { kind: "green" },
    originStale: "own-publish",
    priorPublish: { prUrl: OWN_URL },
    openPrs: [ownRow(branch)],
    execOver: (cmd, opts) => {
      if (opts?.argv?.includes("merge-base") === true) {
        ancestryArgv = opts.argv;
        return deadAncestry();
      }
      return undefined;
    },
  });
  assert(
    r.threw instanceof PublishInfraError &&
      /could not tell whether/.test(r.threw.message) &&
      /exited 128/.test(r.threw.message),
    `(k) an ancestry read that cannot answer is infrastructure, not a refusal (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    r.threw?.message.includes(branch) === true,
    `(k) the infrastructure message names the branch (got ${JSON.stringify(r.threw?.message)})`,
  );
  assert(
    ancestryArgv?.includes("merge-base") === true &&
      ancestryArgv?.includes("--is-ancestor") === true,
    `(k) the read is git's own three-valued probe (${JSON.stringify(ancestryArgv)})`,
  );
  assert(
    originHead(r.origin, branch) === r.priorHead,
    "(k) nothing was pushed on an unreadable read",
  );
}

// -------- (l) a settled row beside the run's own row does not block the exemption
//
// The fail-closed reading of PR STATE is unchanged: a row counts against the push only
// when its state is not positively CLOSED/MERGED. A closed PR on the same branch is
// therefore not a second unsettled row.
{
  const issue = 913;
  const branch = branchOf(issue);
  const r = await drive({
    issue,
    verify: { kind: "green" },
    originStale: "own-publish",
    priorPublish: { prUrl: OWN_URL },
    openPrs: [ownRow(branch), prWithState(57, "https://forge.example/pull/57", branch, "MERGED")],
    // `openPr` looks the row up by head branch and the merged row shares it, so the
    // read of the reused PR's draft state must come from the row the step reuses.
    viewIsDraft: { "55": false },
  });
  assert(
    r.outcome?.kind === "ok",
    `(l) a settled row beside the run's own row still exempts (got ${r.threw?.name}: ${r.threw?.message})`,
  );
}

if (failures() === 0)
  console.log("\nlean publish, re-publishing to the run's own PR: all assertions passed");
for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: a temp dir the OS reaps anyway is not a failing assertion.
  }
}
process.exit(failures());
