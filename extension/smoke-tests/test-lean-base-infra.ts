#!/usr/bin/env bun
/**
 * The base proof reached through the command layer: an infrastructure fault is
 * not a refusal, and a mainline the clone cannot show never becomes the base.
 *
 * Split from `test-lean-seed-base.ts` at AGENTS.md §12's line cap — the two
 * files are one suite split along the seam between the SEED/READY contract
 * (that file: what a base is allowed to be) and the GIT BEHAVIOUR that decides
 * it (this file: what git's answers mean). The inventory in
 * `lib/lean-seed-fixtures.ts` names both halves.
 *
 *   (k) a git infrastructure fault is NOT a "not a commit" refusal: the second
 *       probe's answer decides, and a fault THROWS so the run hands back rather
 *       than posting "not a commit" on an issue whose clone merely could not be
 *       asked;
 *   (l) the seeder PROVES what it probed: a mainline whose object the clone
 *       cannot show, or whose printed name is not the canonical spelling, seeds
 *       `""` with a reason and never a base `ready` would go on to refuse;
 *   (m) a refused base is reported once, in the rule — never echoed in facts.
 */

import { leanSeed, readyOutcome } from "../src/lean/command.ts";
import { makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";
import { BODY, fakeGhDir, originRepo, withGh, withGitBin } from "./lib/lean-seed-fixtures.ts";

const { assert, failures } = makeAssert();

// ── (k) a git infrastructure fault is NOT a "not a commit" refusal.
//
// `resolveHeadSha` answers `undefined` for both halves of that question, so the
// caller's second probe (`git cat-file -e <sha>^{commit}`) is what separates
// them — and the two directions must not be conflated: a base that names no
// object is a `ready` refusal that belongs on the issue, while a git that could
// not be asked (a locked index, a corrupt object store, a timeout) would
// otherwise post "your base is not a commit" on an issue whose clone is merely
// broken. The seam is `repoRoot`: a directory that is not a git repository at
// all makes BOTH git reads fail, and only the second one is allowed to decide.
{
  const notARepo = tempDir();
  try {
    const gh = fakeGhDir(BODY);
    const base = "0123456789abcdef0123456789abcdef01234567";
    let thrown: unknown;
    let out: Awaited<ReturnType<typeof readyOutcome>> | undefined;
    try {
      out = await withGh(gh, () => readyOutcome(notARepo.dir, 4209, { baseSha: base }));
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error,
      `a git infrastructure fault throws rather than refusing (got ${JSON.stringify(out)})`,
    );
    assert(
      /^could not verify base sha 0123456789abcdef0123456789abcdef01234567: /.test(
        (thrown as Error)?.message ?? "",
      ),
      `the throw names the base and the cause (got ${JSON.stringify((thrown as Error)?.message)})`,
    );
    assert(
      (thrown as Error)?.message.length !== undefined &&
        (thrown as Error).message.length <
          "could not verify base sha ".length + 81 + ": ".length + 161,
      `the throw stays inside its clips (len ${(thrown as Error)?.message.length})`,
    );
    // And the throw is a plain Error, not a LeanStateError: the engine's handler
    // -error path is what turns it into a handback, and a typed state error
    // would read as a corrupt record.
    assert(
      (thrown as Error)?.name === "Error",
      `the fault is a plain Error (got name ${JSON.stringify((thrown as Error)?.name)})`,
    );
  } finally {
    notARepo.cleanup();
  }
}

// ── (l) the seeder PROVES what it probed: a mainline that is not the commit it
// claims never becomes the run's base. `mainlineSha` reads refs and the base
// proof peels the value it read; a ref whose object the clone cannot show (a
// prune, a shallow clone) or whose printed name is not what the object store
// answers back (a mixed-case spelling) would otherwise be pinned as the base
// and refused only later by `ready`, after a state file existed claiming a
// commit the run never named. The two shapes are the two halves of the proof,
// and both are reached with the real git doing the peel — only the ref read is
// staged (see `fakeGit` in the fixtures), so the equality and the peel are
// judged by git, not by the case.
{
  const phantom = "1111111111111111111111111111111111111111";
  const repo = originRepo({ fakeGit: `origin/HEAD=${phantom}` });
  try {
    const seed = await withGitBin(repo, () => leanSeed(repo.repoRoot));
    assert(
      seed.baseSha === "",
      `a mainline whose object does not exist seeds an empty base (got ${JSON.stringify(seed.baseSha)})`,
    );
    assert(
      (seed.why ?? "").includes(phantom) && (seed.why ?? "").includes("not a commit"),
      `the reason names the value and what is wrong with it (got ${JSON.stringify(seed.why)})`,
    );
  } finally {
    repo.dispose();
  }
  // The same value refused by the SHAPE half rather than the peel: an uppercase
  // tip is a name git resolves but is not the canonical spelling, and the
  // seeder's reason must still name what it refused.
  const upper = originRepo({ fakeGit: "<upper-tip>" });
  try {
    const seed = await withGitBin(upper, () => leanSeed(upper.repoRoot));
    assert(
      seed.baseSha === "",
      `an uppercase mainline name seeds an empty base (got ${JSON.stringify(seed.baseSha)})`,
    );
    assert(
      (seed.why ?? "").includes(upper.tip.toUpperCase()),
      `the reason names the value the seeder refused (tip ${upper.tip}, why ${JSON.stringify(seed.why)})`,
    );
  } finally {
    upper.dispose();
  }
  // The DIFFERENT-oid branch — a value that passes the shape check and resolves
  // to another one — is pinned in `test-lean-base-proof.ts` (c), which injects
  // the executor: no object store will print a mixed-case name for a commit and
  // then answer the peel in lowercase, so it is only reachable there.
}

// ── (m) a base that RESOLVES — to something else — is refused, and the rule
// says what it resolved to. Exercised through the real code path by handing
// `ready` a value the clone cannot resolve: the equality half and the
// not-a-commit half share one refusal site, and the resolved-to wording is
// pinned against a fabricated answer in `test-lean-base-proof.ts` (c), which
// injects the executor. Here the assertion is that nothing is echoed in FACTS.
{
  const repo = originRepo();
  try {
    const claimed = "2222222222222222222222222222222222222222";
    const out = await withGh(fakeGhDir(BODY), () =>
      readyOutcome(repo.repoRoot, 4210, { baseSha: claimed }),
    );
    assert(
      out.kind === "fail" &&
        out.facts.failedRules.some(
          (r) => r === `base sha ${claimed} is not a commit in this clone`,
        ),
      `a base the clone cannot resolve is refused by the resolution rule (got ${out.kind} ${JSON.stringify(out.facts.failedRules)})`,
    );
    assert(
      (out.facts as { baseSha?: string }).baseSha === undefined,
      `the refused value reaches only the rule, never the facts (got ${JSON.stringify((out.facts as { baseSha?: string }).baseSha)})`,
    );
  } finally {
    repo.dispose();
  }
}

process.exit(failures());
