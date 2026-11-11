#!/usr/bin/env bun
/**
 * #1854 — `start_plan_driver` files into the repository the CALLER names.
 *
 * The defect was live, not theoretical: four plan launches from a session in
 * another repository all filed into the SESSION repo, and the last minted a real
 * issue number in the wrong tracker. Every message the run emitted was
 * self-consistent, because every consumer (forge detection, the create call, the
 * pre-filing label read, the investigation children, the cache) was right about
 * the repository it had actually been given.
 *
 * What this suite pins, and why each one is the assertion that matters:
 *
 *   1. A supplied target is the repository the CREATE CALL goes through — asserted
 *      through the forge adapter's construction `cwd`, because `installForgeStub`
 *      replaces the adapter wholesale and a stub alone cannot say where the issue
 *      would land.
 *   2. A label that exists only on the TARGET is accepted, and one absent from it
 *      is refused naming the target — the exact false refusal observed live.
 *   3. Every dispatched child's `cwd` is the TARGET, so no read silently stays on
 *      the session repo (a child that re-derives the session repo reproduces the
 *      parent/child line-number disagreement that was observed in the real run).
 *   4. An unusable target refuses BEFORE any dispatch: zero explore, zero gate,
 *      zero forge resolves, zero creates. Proven by absence of side effects, not
 *      by matching an error string.
 *   5. A target that resolves to the session repo refuses (it would otherwise file
 *      into the session tracker, the very failure being fixed).
 *   6. The reviewedDigest changes with the target, so a reviewed dry run for
 *      repository A cannot file into repository B.
 *   7. Omitting the input reproduces today's behaviour exactly: same launch-notice
 *      bytes, same report bytes, session repo everywhere.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Forge } from "../src/forge.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { setPlanForge } from "../src/plan-filing.ts";
import { setPlanGitStateFn } from "../src/plan-investigation-cache.ts";
import {
  DEFAULT_HOST,
  PLAN_TARGET_OVERRIDE_ENV,
  identityText,
  parseRepoIdentity,
  type RepoIdentity,
  repoIdentityAt,
  resolvePlanTarget,
  sameIdentity,
} from "../src/plan-target.ts";
import { type RegisteredPlanTool, registerPlanTool } from "../src/plan-tool.ts";
import {
  confirmAcrossTargetSpellings,
  heldForReviewHashesIdentity,
  installRecordingForge,
  resolvedCwds,
} from "./plan-target-confirm-scenarios.ts";
import {
  forgeStub,
  installOfflineVipuneStub,
  invokePlanToolFull,
  makeJobDeliverer,
} from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------- fixtures
// Each fixture repository is a clone of its own bare origin, so `origin/HEAD`
// resolves and the base-tree fetch stays local (the multi-clone shape
// test-plan-cache-settings.ts already uses). Each clone's `origin` is then pointed
// at a canonical remote URL, which is the bytes production's `repoIdentityAt` reads
// — the tests therefore exercise the REAL origin-to-identity resolution rather than
// a fixture's paraphrase of it.

const root = await mkdtemp(path.join(os.tmpdir(), "plan-target-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();

/**
 * A clone of a fresh local bare origin whose `origin` remote names
 * `<host>/<owner>/<repo>` — the identity its caller would pass. `<host>` carries a
 * dot so the parser reads it as a host; `owner` is a namespace segment, so the two
 * fixtures cannot collide and a second clone of one origin shares its identity.
 */
function makeClone(repo: string, cloneName: string, host: string, owner: string): string {
  const home = path.join(root, `${repo}-${cloneName}`);
  const seed = path.join(home, "seed");
  execFileSync("git", ["init", "-q", seed]);
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
  const origin = path.join(home, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  const dir = path.join(home, "work");
  execFileSync("git", ["clone", "-q", origin, dir]);
  // The remote the identity is read from. Set explicitly, because a local-path
  // origin is not a `host/owner/repo` and `parseRemoteUrl` refuses it — which is
  // correct behaviour this suite must not accidentally test around.
  git(dir, "remote", "set-url", "origin", `https://${host}/${owner}/${repo}.git`);
  return dir;
}

const HOST = "plan-target.test";
const SESSION = { dir: makeClone("session-repo", "a", HOST, "team-one") };
const TARGET = { dir: makeClone("target-repo", "a", HOST, "team-two") };
/** A second clone of the SESSION repository: another directory, one identity. */
const SAME = { dir: makeClone("session-repo", "b", HOST, "team-one") };

/** The identity the clone at `dir` reports, through production's own reader. */
async function identityOf(dir: string): Promise<RepoIdentity> {
  const id = await repoIdentityAt(dir);
  if (!id) throw new Error(`fixture: ${dir} reports no repository identity`);
  return id;
}

const SESSION_ID = identityText(await identityOf(SESSION.dir));
const TARGET_ID = identityText(await identityOf(TARGET.dir));
/** SAME clones the session origin, so it names the session repository. */
const SAME_ID = identityText(await identityOf(SAME.dir));

// ------------------------------------------------------ dispatch observation
// The dispatch stub records the `cwd` of EVERY child, so "the children are briefed
// with the target" is asserted on the spec object the driver actually built — the
// field that decides which tree a child reads.

interface Seen {
  role: string;
  cwd: string | undefined;
}
const seen: Seen[] = [];

setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string; cwd?: string }) => {
  seen.push({ role: spec.role, cwd: spec.cwd });
  const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
  if (spec.role === "adversarial-developer") {
    return Promise.resolve({ ...base, role: spec.role, text: "VERDICT: READY" });
  }
  if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "DUPLICATE_RISK: none — no overlapping open work",
    });
  }
  return Promise.resolve({
    ...base,
    role: "explore",
    text: "summary prose",
    toolUses: [
      {
        name: "report_plan_item",
        arguments: { kind: "acceptance-criterion", text: "the target is threaded", angle: "x" },
      },
    ],
  });
}) as never);

// ------------------------------------------------------------- the tool under test
const tools: RegisteredPlanTool[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal stub; registerTool + delivery only
const fakePi = {
  registerTool: (def: RegisteredPlanTool) => tools.push(def),
  ...makeJobDeliverer(),
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub; registerTool + delivery only
} as any;
registerPlanTool(fakePi);

const DESC = "fix the target resolution in extension/src/plan-tool.ts so it files elsewhere";

/** One tool call, driven to its delivered report (or to its pre-launch refusal). */
async function call(params: Record<string, unknown>, sessionDir = SESSION.dir) {
  seen.length = 0;
  // A second clone of one repository is a real second directory, and the session's
  // own worktree list does not cover it — the operator-facing channel for a clone
  // the session does not already know is the environment override (see
  // PLAN_TARGET_OVERRIDE_ENV). Set for every call and restored after, so no block
  // inherits another's clone list; with the variable unset, resolution falls back
  // to the session's clones, which is what the "no local clone" assertions measure.
  process.env[PLAN_TARGET_OVERRIDE_ENV] = [TARGET.dir, SAME.dir].join(",");
  try {
    // The session directory is the harness's ctx.cwd — the ONLY input that decides
    // the session side of a cross-repo call.
    return await invokePlanToolFull(tools, { descriptor: DESC, ...params }, sessionDir);
  } finally {
    delete process.env[PLAN_TARGET_OVERRIDE_ENV];
  }
}

// No cache, no vipune: the assertions are about the TARGET, and a cache hit would
// skip the very phases whose side effects are being measured.
setPlanGitStateFn(null);
installOfflineVipuneStub();

// ============================ (1) identity parsing — the shape of the parameter

{
  const ok = [
    "owner/repo",
    "github.com/owner/repo",
    "gitlab.example.com/group/sub/project",
    "GitLab.Example.com/Group/Sub/Project",
    "owner/repo.git",
  ];
  for (const good of ok) {
    assert(parseRepoIdentity(good) !== undefined, `accepted: ${good}`);
  }
  const bad = [
    "/home/user/elsewhere",
    "./relative/checkout",
    "https://github.com/owner/repo",
    "git@github.com:owner/repo.git",
    "owner",
    "",
    "  ",
    "owner/repo,other/repo",
    "--upload-pack=evil",
    "../owner/repo",
    "owner/repo/../..",
    "owner/repo with space",
  ];
  for (const no of bad) {
    assert(parseRepoIdentity(no) === undefined, `refused: ${JSON.stringify(no)}`);
  }
  const bare = parseRepoIdentity("owner/repo");
  assert(
    bare?.host === DEFAULT_HOST && bare.segments.join("/") === "owner/repo",
    `a bare owner/repo means ${DEFAULT_HOST}`,
  );
  assert(
    identityText(parseRepoIdentity("GitLab.Example.com/Group/Sub/Project") ?? {
      host: "",
      segments: [],
    }) === "gitlab.example.com/Group/Sub/Project",
    "the host lower-cases and the namespace path keeps its case",
  );
  assert(
    sameIdentity(parseRepoIdentity("GitHub.com/Owner/Repo"), parseRepoIdentity("github.com/Owner/Repo")),
    "two spellings of one repository are the same identity",
  );
  assert(
    !sameIdentity(parseRepoIdentity("a.com/o/r"), parseRepoIdentity("b.com/o/r")),
    "same path on a different host is a DIFFERENT repository",
  );
}

// ============================ (2) resolution — clones, refusals, no fallback

{
  const real = await resolvePlanTarget(undefined, SESSION.dir);
  assert(
    real.ok && real.target.repoRoot === SESSION.dir && !real.target.crossRepo,
    "omitted target: the session repo, unchanged, and not a cross-repo run",
  );

  const pathish = await resolvePlanTarget("/home/user/elsewhere", SESSION.dir);
  assert(
    !pathish.ok && /not a repository identity/.test(pathish.problem),
    "a filesystem path is refused, not resolved",
  );
  assert(
    !pathish.ok && /repository, not a directory/.test(pathish.problem),
    "the path refusal says why a path is not an identity",
  );

  const ghost = await resolvePlanTarget("ghostcorp/ghostrepo", SESSION.dir);
  assert(
    !ghost.ok && /no local clone of github.com\/ghostcorp\/ghostrepo/.test(ghost.problem),
    "an unknown identity refuses naming what was asked for",
  );
  assert(
    !ghost.ok && ghost.problem.includes(SESSION_ID),
    "the refusal names the repository this session is actually in",
  );
  assert(
    !ghost.ok && /NOT filed into/.test(ghost.problem),
    "the refusal states there was no fallback filing into the session repo",
  );
}

// ============================ (3) the whole run targets the named repository

{
  installRecordingForge(TARGET.dir);
  const r = await call({ targetRepository: TARGET_ID, dryRun: false });
  assert(r.details.filed === true, "target: the plan filed");
  assert(forgeStub.created.length === 1, "target: exactly one create call");
  assert(
    resolvedCwds.length === 1 && resolvedCwds[0] === TARGET.dir,
    `target: the forge adapter was built with the TARGET as its cwd (got ${JSON.stringify(resolvedCwds)})`,
  );
  // Children read origin/<default> in a per-run worktree (plan-base-tree.ts), so
  // the assertion is that every tree a child read lies INSIDE the target clone —
  // and that none of them lies inside the session clone. That is what the live
  // incident turned on: a child that re-derives the session repo re-introduces the
  // parent/child line-number disagreement the report recorded.
  const cwds = [...new Set(seen.map((s) => s.cwd).filter((c): c is string => !!c))];
  const inside = (d: string, root: string) => d === root || d.startsWith(`${root}${path.sep}`);
  assert(
    seen.length > 2 && cwds.length > 0 && cwds.every((c) => inside(c, TARGET.dir)),
    `target: every child (risk, angles AND gate) read a tree inside the TARGET clone (got ${JSON.stringify(cwds)})`,
  );
  assert(
    !cwds.some((c) => inside(c, SESSION.dir)),
    `target: no child read the session clone (got ${JSON.stringify(cwds)})`,
  );
  const notice = r.launch.content[0]?.text ?? "";
  assert(
    /target repository: /.test(notice) && notice.includes(TARGET_ID),
    "target: the launch notice names the resolved target repository",
  );
  assert(
    r.text.includes("=== TARGET REPOSITORY ===") && r.text.includes(TARGET_ID),
    "target: the completion report names the resolved target repository",
  );
  assert(
    r.launch.details.targetRepository === TARGET_ID,
    "target: the launch details carry the target identity",
  );
}

// ============================ (4) the label gate is checked against the TARGET

{
  // A label that exists ONLY on the target. Verified against the session repo
  // (the live bug) this is refused; against the target it must pass, and the
  // adapter that answers the read must be the target's.
  // `installRecordingForge` resets the recorder and `existing`, so the label list is
  // installed AFTER it — otherwise the gate reads an empty list and the run cannot
  // file at all.
  installRecordingForge(TARGET.dir);
  forgeStub.existing = ["auto-filed"];
  const r = await call({ targetRepository: TARGET_ID, labels: ["auto-filed"], dryRun: false });
  assert(
    r.details.filed === true && forgeStub.created[0]?.labels?.join() === "auto-filed",
    "labels: a label held only by the target files with it",
  );
  assert(
    forgeStub.labelListCalls === 1 && resolvedCwds.every((c) => c === TARGET.dir),
    `labels: the existence read went to the target's adapter, once (reads=${forgeStub.labelListCalls}, cwds=${JSON.stringify(resolvedCwds)})`,
  );

  // Now the same label is absent from the target: refused, and the refusal names
  // the target — not the session repo, which the live run blamed.
  installRecordingForge(TARGET.dir);
  forgeStub.existing = [];
  const m = await call({ targetRepository: TARGET_ID, labels: ["auto-filed"], dryRun: false });
  assert(
    m.details.filingFailure?.reason === "label-missing",
    `labels: a label the target lacks halts as label-missing (got ${JSON.stringify(m.details.filingFailure)})`,
  );
  assert(m.details.filed === false, "labels: nothing filed under a missing label");
  assert(resolvedCwds.every((c) => c === TARGET.dir), "labels: the refusal came from the target's adapter");
  forgeStub.existing = null;
}

// ============================ (5) an unusable target refuses BEFORE any dispatch

{
  installRecordingForge(TARGET.dir);
  const ghost = await call({ targetRepository: "ghostcorp/ghostrepo" });
  assert(
    ghost.jobId === "" && ghost.details.started === false,
    "refusal: nothing launched, so no steer and no job",
  );
  assert(
    ghost.details.error === "invalid-target-repository",
    `refusal: the error names the cause (got ${JSON.stringify(ghost.details.error)})`,
  );
  assert(seen.length === 0, "refusal: zero children dispatched (proven by absence, not by the message)");
  assert(
    forgeStub.created.length === 0 && forgeStub.resolveCalls === 0,
    "refusal: no forge was built and nothing was created",
  );
  assert(/ghostcorp\/ghostrepo/.test(ghost.text), "refusal: the message names the repository asked for");
  assert(
    ghost.text.includes(SESSION_ID) || /not a git clone/.test(ghost.text),
    "refusal: the message names the repository the session is in",
  );
}

// ============================ (6) a target that IS the session repo refuses

{
  // `SAME` is a second clone of the session's origin URL: a DIFFERENT directory,
  // the SAME repository. Passing its identity would resolve to a real local clone
  // and file into the session tracker — the exact failure this parameter removes.
  const r = await call({ targetRepository: SAME_ID });
  assert(
    r.jobId === "" && r.details.started === false,
    "self-target: refused before launch rather than filed into the session repo",
  );
  assert(
    /ALREADY in/.test(r.text) && r.text.includes(SAME_ID),
    `self-target: the refusal names the repository it was asked for (got ${r.text.slice(0, 160)})`,
  );
  assert(seen.length === 0 && forgeStub.created.length === 0, "self-target: no side effects at all");
}

// ============================ (7) omitted input is byte-identical to today

{
  installRecordingForge(SESSION.dir);
  const a = await call({ dryRun: true });
  const notice = a.launch.content[0]?.text ?? "";
  assert(
    notice.includes(`repo: ${SESSION.dir}`) && !/target repository:/.test(notice),
    "omitted: the launch notice is the pre-#1854 shape — one repo field, no target clause",
  );
  assert(
    a.launch.details.targetRepository === undefined,
    "omitted: the launch details carry no target field",
  );
  assert(
    !a.text.includes("=== TARGET REPOSITORY ==="),
    "omitted: the completion report gains no section",
  );
  const cwds = [...new Set(seen.map((s) => s.cwd).filter((c): c is string => !!c))];
  const insideSession = (d: string) => d === SESSION.dir || d.startsWith(`${SESSION.dir}${path.sep}`);
  assert(
    seen.length > 2 && cwds.length > 0 && cwds.every(insideSession),
    `omitted: every child read a tree inside the SESSION clone (got ${JSON.stringify(cwds)})`,
  );
}

// ============================ (8) the digest binds the target

{
  // A cache, so each dry run writes an entry and the NEXT call could reuse it —
  // the reuse path is exactly where a wrong-target lineage would leak. The digests
  // must differ, and the same target must reproduce its own.
  let cacheDir = await mkdtemp(path.join(os.tmpdir(), "plan-target-cache-"));
  setPlanGitStateFn(async () => ({ keySha: "b".repeat(40), cacheDir }));
  installRecordingForge(TARGET.dir);
  const a = await call({ targetRepository: TARGET_ID, dryRun: true });
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "plan-target-cache-"));
  installRecordingForge(SESSION.dir);
  const b = await call({ dryRun: true });
  assert(
    !!a.details.reviewedDigest && !!b.details.reviewedDigest,
    "digest: both runs reported a reviewedDigest",
  );
  assert(
    a.details.reviewedDigest !== b.details.reviewedDigest,
    "digest: the same spec for a different repository has a different digest",
  );
  const c = await call({ targetRepository: TARGET_ID, dryRun: true });
  assert(
    c.details.reviewedDigest === a.details.reviewedDigest,
    "digest: the same target and inputs reproduce the digest (a confirm can echo it)",
  );
  setPlanGitStateFn(null);
}

// --------------------------------------------------------------- teardown
//
// The confirm/digest half of the feature is asserted in
// plan-target-confirm-scenarios.ts — the digest and the held-for-review guard,
// driven by the harness below. The cache/digest stubs those scenarios drive
// already live beside the other plan test stubs, which is the seam
// `plan-confirm-label-scenarios.ts` drew for #1377, and the same reason: this file
// stays one readable suite under the cap (AGENTS.md §12).

await confirmAcrossTargetSpellings(assert, {
  call: (params) => call(params),
  installForge: installRecordingForge,
  resolvedCwds,
  seen,
  created: forgeStub.created,
  targetDir: TARGET.dir,
  targetId: TARGET_ID,
  makeCacheDir: () => mkdtemp(path.join(os.tmpdir(), "plan-target-confirm-")),
});
heldForReviewHashesIdentity(assert, DESC, TARGET_ID);

setPlanForge(null);
setPlanDispatch(null);
setPlanGitStateFn(null);
await rm(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
