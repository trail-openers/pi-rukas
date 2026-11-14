#!/usr/bin/env bun
/**
 * The publish guard fails CLOSED when the mainline cannot be read (#2255).
 *
 * `assertPublishableBranch` is the one check all three force-push sites on the
 * run's branch share — `publish`, the review's fix push, and the verified
 * handback's rewind. Its rule 2 compares the pushed branch against the resolved
 * mainline, and for as long as an unreadable mainline read as "no problem" the
 * guard's second rule was a rule a machine could opt out of by not answering.
 *
 * The fix's policy (R2) is: resolve the mainline the way the push will reach
 * origin. When `resolveMainline` answers not-ok the guard asks origin itself —
 * `git ls-remote --symref origin HEAD` — through the CALLER's exec, and refuses
 * with a named `PublishInfraError` (quoting the probe causes) only when THAT
 * fails too. A clone that can force-push can answer that probe; a clone that
 * cannot answer it could not have pushed either, so refusing costs nothing.
 *
 * What each case is for:
 *
 *   (a) both probes fail → a named refusal, no push, causes quoted — and the
 *       recorder proves the probes reached the fake. A seam that forwards only
 *       the argv form answers nothing, silently, and looks exactly like this arm.
 *   (b) the local probes fail and origin answers → the run proceeds. This is the
 *       shallow-clone case the old fail-open existed for; failing closed here
 *       would refuse every fix round on an ordinary clone.
 *   (c) origin answers and the branch IS origin's HEAD → refused, on exact equality.
 *   (d) rule ordering (R3): a name rule 1 refuses is refused by rule 1's own
 *       sentence even on a host where the mainline would never answer.
 *   (e) origin's HEAD is `lean/trunk` and the run's branch is `lean/trunk` →
 *       refused. Per R9 this behaviour is ALREADY correct on main — `mainline.ts`
 *       strips only `origin/` and the guard compares bare names with `===` — so
 *       this case PINS already-correct behaviour rather than claiming a fix.
 *   (f) `assertSafeRef` still runs first.
 *   (g) `PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED=0` restores the fail-open (R8): the
 *       same host (a) refuses passes quietly, and pays nothing for the new probe.
 *   (h) every probe the guard issues carries a timeout bound — a probe that can
 *       settle never is the fail-open wearing a different hat.
 *   (i) the PRODUCTION wiring (R6): `publishDeps()`'s own executor against a real
 *       clone with no `refs/remotes/origin/HEAD` and no `gh` on PATH, so the arm a
 *       real run takes is covered by a case rather than by a reading of the source.
 *
 * Run: cd extension && bun run smoke-tests/test-lean-publish-guard-fail-closed.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublishInfraError, assertPublishableBranch } from "../src/lean/publish-deps.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { originHead } from "./lib/lean-publish-asserts.ts";
import { git } from "./lib/lean-verify-fixture.ts";
import { spawnSync } from "node:child_process";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import {
  PROBE,
  guardRealExec,
  mkGuardExec,
  pushCalls,
  symrefReply,
} from "./fixtures/publish-guard-fixture.ts";

const { assert, failures } = makeAssert();

/** A lean branch name that clears rule 1, so only the mainline rule can refuse. */
const LEAN = "lean/issue-2255";

/** A scratch dir on disk, for the cases that need a real clone rather than a fake cwd. */
function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "lean-guard-"));
}

/**
 * A local ref read that is allowed to fail: `git rev-parse --verify --quiet` exits
 * 1 for an absent ref, which is the ANSWER this precondition is asking for. The
 * fixture's `git` helper throws on any non-zero exit, so a probe of absence needs
 * its own call — and the empty string it returns here is what the assertion below
 * reads as "this clone has no such ref".
 */
function refOrEmpty(dir: string, ref: string): string {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
    cwd: dir,
    encoding: "utf8",
    env: gitTestEnv(),
  });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

/**
 * (a) THE ARM THE BUG WAS: nothing answers the probes, so nothing may be pushed.
 */
{
  const fake = mkGuardExec(() => ({ reject: "git: no such ref" }));
  const err = await assertPublishableBranch("/no/such/clone", LEAN, fake.exec).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  assert(
    err instanceof PublishInfraError,
    `(a) an unreadable mainline throws PublishInfraError instead of passing (got ${err?.name}: ${err?.message})`,
  );
  assert(
    (err?.message ?? "").includes(LEAN),
    `(a) the refusal names the branch it refused (${String(err?.message)})`,
  );
  assert(
    fake.saw(PROBE.symbolicRef) && fake.saw(PROBE.gh),
    `(a) both resolveMainline probes reached the injected exec (${JSON.stringify(fake.calls.map((c) => [c.cmd, c.argv]))})`,
  );
  assert(
    fake.saw("ls-remote", "origin", "HEAD"),
    `(a) and the guard asked origin directly once resolveMainline answered not-ok (${JSON.stringify(fake.calls.map((c) => [c.cmd, c.argv]))})`,
  );
  assert(
    /no such ref/.test(err?.message ?? ""),
    `(a) the refusal quotes the probe's own cause, so the handoff says WHICH probe failed (${String(err?.message)})`,
  );
  assert(
    pushCalls(fake.calls).length === 0,
    `(a) and no push reached the caller's exec (${JSON.stringify(fake.calls.map((c) => c.argv))})`,
  );
}

/**
 * (b) THE CLONE THAT CAN PUSH CAN ANSWER.
 *
 * `symbolic-ref` and `gh` both fail — the ordinary shape of a clone that never
 * had `origin/HEAD` and has no `gh` — and origin answers the symref probe. This
 * run must not be refused.
 */
{
  const fake = mkGuardExec((line) => {
    if (line.includes(PROBE.symbolicRef)) return { reject: "not a symbolic ref" };
    if (line.includes(PROBE.gh)) return { reject: "gh: command not found" };
    if (line.includes(PROBE.lsRemote)) return symrefReply("main");
    return undefined;
  });
  const err = await assertPublishableBranch("/no/such/clone", LEAN, fake.exec).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  assert(
    err === undefined,
    `(b) a legitimate lean push goes through when origin answers the symref probe, whatever local git and gh said (${err?.name}: ${err?.message})`,
  );
  assert(
    fake.saw("ls-remote", "origin", "HEAD"),
    `(b) the run was not passed by a probe nobody answered (${JSON.stringify(fake.calls.map((c) => [c.cmd, c.argv]))})`,
  );
}

/**
 * (c) origin's HEAD IS the branch: refused, on the exact name.
 */
{
  const fake = mkGuardExec((line) => {
    if (line.includes(PROBE.lsRemote)) return symrefReply(LEAN);
    return undefined;
  });
  const err = await assertPublishableBranch("/no/such/clone", LEAN, fake.exec).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  assert(
    err instanceof PublishInfraError && /mainline/.test(err.message),
    `(c) a branch equal to origin's HEAD is refused by the mainline rule (${err?.name}: ${err?.message})`,
  );
  assert(
    (err?.message ?? "").includes(LEAN),
    `(c) and the refusal names the mainline it collided with (${String(err?.message)})`,
  );
}

/**
 * (d) RULE ORDER, PINNED (R3): assertSafeRef → the `lean/` rule → the mainline.
 */
{
  const fake = mkGuardExec(() => ({ reject: "nothing answers here" }));
  const err = await assertPublishableBranch("/no/such/clone", "main", fake.exec).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  assert(
    /work-lean pushes only lean\/ branches/.test(err?.message ?? ""),
    `(d) \`main\` is still refused by rule 1's own sentence on an unanswerable host (${err?.name}: ${err?.message})`,
  );
  assert(
    !/mainline/.test(err?.message ?? ""),
    `(d) and the mainline rule never spoke for a name the prefix rule refused (${String(err?.message)})`,
  );
}

/**
 * (e) A MAINLINE WHOSE NAME STARTS WITH `lean/` (R4), pinned as already-correct
 * behaviour per R9 — see the case's note in the module header.
 */
{
  const fake = mkGuardExec((line) => {
    if (line.includes(PROBE.lsRemote)) return symrefReply("lean/trunk");
    return undefined;
  });
  const err = await assertPublishableBranch("/no/such/clone", "lean/trunk", fake.exec).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  assert(
    err instanceof PublishInfraError && /mainline/.test(err.message),
    `(e) a run whose branch IS the lean/ mainline origin calls HEAD is refused (${err?.name}: ${err?.message})`,
  );
  assert(
    (err?.message ?? "").includes("lean/trunk"),
    `(e) and the refusal names it rather than the prefix rule (${String(err?.message)})`,
  );
  // The companion that keeps (e) a MAINLINE rule rather than a blanket refusal of
  // every `lean/` name: a different lean branch under the same origin HEAD passes.
  const other = mkGuardExec((line) => {
    if (line.includes(PROBE.lsRemote)) return symrefReply("lean/trunk");
    return undefined;
  });
  const ok = await assertPublishableBranch("/no/such/clone", "lean/issue-9", other.exec).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  assert(
    ok === undefined,
    `(e) control: another lean/ branch under that same origin HEAD still publishes (${ok?.name}: ${ok?.message})`,
  );
}

/**
 * (f) `assertSafeRef` still runs first: an illegal name is refused as an illegal
 * name before the guard asks anything of git.
 */
{
  const fake = mkGuardExec(() => undefined);
  const err = await assertPublishableBranch("/no/such/clone", "a:b", fake.exec).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  assert(
    err instanceof PublishInfraError && /valid ref name/.test(err.message),
    `(f) an unsafe ref is refused by assertSafeRef and wrapped as PublishInfraError (${err?.name}: ${err?.message})`,
  );
  assert(
    fake.calls.length === 0,
    `(f) and nothing was asked of git for a name already refused (${JSON.stringify(fake.calls.map((c) => c.argv))})`,
  );
}

/**
 * (g) THE OFF ARM IS TODAY (R8).
 *
 * Same host as (a) — every probe rejects — and with the switch at `"0"` the run
 * passes quietly, which is the fail-open the guard shipped with; and the off arm
 * must not pay for the probe the fix added. `main` is still refused by rule 1, so
 * the switch reaches the fail-closed half and nothing else.
 */
await withEnv({ PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED: "0" }, async () => {
  const fake = mkGuardExec(() => ({ reject: "git: no such ref" }));
  const quiet = await assertPublishableBranch("/no/such/clone", LEAN, fake.exec).then(
    () => true,
    () => false,
  );
  assert(
    quiet,
    "(g) with PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED=0 an unreadable mainline passes quietly — the fail-open, restored",
  );
  assert(
    !fake.saw("ls-remote", "origin", "HEAD"),
    `(g) and the off arm never pays for the origin probe the fix added (${JSON.stringify(fake.calls.map((c) => [c.cmd, c.argv]))})`,
  );
  const mainErr = await assertPublishableBranch("/no/such/clone", "main", fake.exec).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  assert(
    /work-lean pushes only lean\/ branches/.test(mainErr?.message ?? ""),
    `(g) and the off arm still refuses \`main\` with rule 1's own sentence (${mainErr?.message})`,
  );
});

/**
 * (h) Every probe the guard issues carries a timeout bound.
 */
{
  const fake = mkGuardExec(() => ({ reject: "no answer" }));
  await assertPublishableBranch("/no/such/clone", LEAN, fake.exec).catch(() => undefined);
  const bounded = fake.calls.filter((c) => typeof c.timeout === "number" && c.timeout > 0);
  assert(
    fake.calls.length > 0 && bounded.length === fake.calls.length,
    `(h) every probe the guard issued carried a timeout (${JSON.stringify(fake.calls.map((c) => [c.cmd, c.timeout]))})`,
  );
}

/**
 * (i) THE PRODUCTION WIRING (R6).
 *
 * The lean publish fixture injects its own executor, so without this case
 * nothing drives the arm a real run takes: a real clone with no
 * `refs/remotes/origin/HEAD`, no `gh` on PATH, and the executor `publishDeps()`
 * actually builds.
 */
{
  const dir = scratch();
  const origin = scratch();
  git(origin, "init", "-q", "--bare");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  // `push origin main`, NOT `push -u`: the upstream form is what writes
  // refs/remotes/origin/HEAD, and this clone must not have it.
  git(dir, "push", "-q", "origin", "main");
  const noHead = refOrEmpty(dir, "refs/remotes/origin/HEAD");
  assert(noHead === "", `(i) precondition: this clone has no refs/remotes/origin/HEAD (${noHead})`);

  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent-for-this-case";
  let okErr: Error | undefined;
  let mainErr: Error | undefined;
  let wiredErr: Error | undefined;
  try {
    okErr = await assertPublishableBranch(dir, LEAN, guardRealExec).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    mainErr = await assertPublishableBranch(dir, "main", guardRealExec).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    // The same through the production deps object, so the executor `publish`
    // really hands the guard is the one under test.
    const { publishDeps } = await import("../src/lean/publish-deps.ts");
    wiredErr = await assertPublishableBranch(dir, "lean/production-wired", publishDeps().exec).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
  } finally {
    process.env.PATH = savedPath;
  }
  assert(
    okErr === undefined,
    `(i) the production executor resolves origin's HEAD for a lean branch with no local origin/HEAD (${okErr?.name}: ${okErr?.message})`,
  );
  assert(
    wiredErr === undefined,
    `(i) and the real publishDeps().exec carries the guard through to origin (${wiredErr?.name}: ${wiredErr?.message})`,
  );
  assert(
    mainErr instanceof PublishInfraError &&
      /work-lean pushes only lean\/ branches/.test(mainErr.message),
    `(i) the production executor still refuses \`main\` by rule 1 (${mainErr?.name}: ${mainErr?.message})`,
  );
  assert(
    originHead(origin, "main") !== "",
    `(i) and origin's mainline is still where the fixture left it (${originHead(origin, "main")})`,
  );
}

console.log(`\n${failures() === 0 ? "guard green" : "guard RED"} (${String(failures())} failing)`);
process.exit(failures());
