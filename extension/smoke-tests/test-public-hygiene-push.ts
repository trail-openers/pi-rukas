/**
 * public-hygiene push scan (#1788) — the two-tier rule the issue's criteria pin
 * in BOTH directions, against a real repository.
 *
 * ## The two-tier rule, and why a push is not the same check as a comment
 *
 * The private denylist applies to a push's commit MESSAGES and its ADDED diff
 * lines. The built-in generic set (private IPv4s, personal home paths) applies
 * to commit messages but NOT to diff lines: a test fixture legitimately carries
 * an example address, and a guard that refused it would be switched off within a
 * week. Blocks 1, 2 and 4 assert both halves of that split.
 *
 * ## The seams the fixture pins
 *
 * The clone, the argv transport, the `remoteUrl` seam and the pinned denylist env
 * all live in `lib/push-fixture.ts`, which says why each is pinned. The REFSPEC
 * rule, which blocks 8–14 pin: the scan reads the commits the COMMAND names, not
 * the ones HEAD happens to point at. `git push origin <branch>` with HEAD on a
 * clean branch used to scan HEAD's range and pass the dirty branch through
 * unscanned. Every case there makes the pushed branch dirty and HEAD's branch
 * clean, so a scan that still inferred HEAD would be green for the wrong reason
 * and the assertions say so. The sibling file `test-public-hygiene-push-cwd.ts`
 * pins the other half: that the scan asks git in the directory the command names.
 *
 * Synthetic terms only.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { scanPushRange } from "../src/public-hygiene-push.ts";
import {
  GITHUB_REMOTE_URL,
  OTHER_FORGE_URL,
  ScanEnv,
  TERM,
  baseSha,
  cleanup,
  commit,
  commitOn,
  exec,
  fixtureRoot,
  git,
  gitIn,
  gitTransport,
  githubUrl,
  inspect,
  otherForgeUrl,
  pushCommand,
  remoteHas,
  repo,
  reset,
  scanOpts,
} from "./lib/push-fixture.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

// ── 1. A term in an ADDED LINE refuses, and the refusal names the path.
{
  await commit("dirty.txt", `host = ${TERM}\n`, "chore: add config");
  const r = await scanPushRange({
    exec,
    cwd: repo,
    remoteUrl: githubUrl,
    ...scanOpts(pushCommand()),
  });
  assert(r.scanned, "a github.com remote is scanned");
  const hit = await inspect(pushCommand());
  assert(hit !== undefined, "a push with a term in an added line is refused");
  assert(hit?.verdict.kind === "denylist", "the refusal is a denylist hit");
  assert(
    hit?.verdict.kind === "denylist" && hit.verdict.location.includes("dirty.txt"),
    "the refusal names the diff path so the agent knows where to look",
  );
  assert(hit !== undefined && !hit.reason.includes(TERM), "the refusal carries no term");
  assert(
    hit?.reason.includes("PI_ENSEMBLE_PUBLIC_HYGIENE=0"),
    "the refusal names the escape hatch",
  );
  await reset();
}

// ── 2. A term in a COMMIT MESSAGE refuses.
{
  await commit("clean.txt", "nothing private here\n", `chore: wire ${TERM} into the build`);
  const hit = await inspect(pushCommand());
  assert(hit !== undefined, "a push with a term in a commit message is refused");
  assert(hit?.verdict.kind === "denylist", "the refusal is a denylist hit");
  assert(
    hit?.verdict.kind === "denylist" && hit.verdict.location.startsWith("commit message ("),
    "the refusal names the commit message and its short sha",
  );
  assert(hit !== undefined && !hit.reason.includes(TERM), "the refusal carries no term");
  await reset();
}

// ── 3. A CLEAN outgoing range passes.
{
  await commit("clean2.txt", "a perfectly public line\n", "chore: add a public note");
  assert((await inspect(pushCommand())) === undefined, "a clean outgoing range is allowed");
  await reset();
}

// ── 4. The two-tier rule, other direction: the generic set is applied to
// NOTHING this module reads out of git. A private IPv4 in an added line passes,
// and so does the same address in an outgoing commit message — the two halves of
// a push scan on the private denylist alone, because a commit message is as
// likely as a fixture to describe an address it is not leaking ("point the build
// at 10.1.2.3"), and a guard that refused either gets switched off. The inline
// text a COMMAND carries (a `-m`, a `--body`) stays on both tiers — there the
// agent typed what it is about to publish. `public-hygiene-push.ts`'s header and
// the troubleshooting entry state the same rule; this is the assertion that keeps
// the three from drifting apart.
{
  await reset();
  await commit(
    "ip.txt",
    "server = 10.1.2.3\nhome = /home/alice/work\n",
    "chore: add fixture values",
  );
  assert(
    (await inspect(pushCommand())) === undefined,
    "the generic set is NOT applied to added diff lines (the tier split, other direction)",
  );
  await reset();
  await commit("ip2.txt", "public\n", "chore: point the build at 10.1.2.3");
  const genericInMessage = await inspect(pushCommand());
  assert(
    genericInMessage === undefined,
    "the generic set is NOT applied to an outgoing commit message either — one rule for everything read out of git",
  );
  await reset();
  await commit("ip3.txt", "public\n", `chore: point the build at ${TERM}`);
  const denyHit = await inspect(pushCommand());
  assert(
    denyHit?.verdict.kind === "denylist",
    "the PRIVATE denylist still refuses a commit message, so the tier split is not an off switch",
  );
  await reset();
}

// ── 5. No github.com remote: nothing here publishes to the public forge.
{
  await git("remote", "set-url", "origin", OTHER_FORGE_URL);
  await commit("other.txt", `still ${TERM} is not published here\n`, "chore: other forge");
  const r = await scanPushRange({
    exec,
    cwd: repo,
    remoteUrl: otherForgeUrl,
    ...scanOpts(pushCommand()),
  });
  assert(!r.scanned && r.problems.length === 0, "a non-github remote is not scanned");
  assert(
    (await inspect(pushCommand(), { remote: otherForgeUrl })) === undefined,
    "a non-github.com remote is not push-scanned (issue decision 3)",
  );
  await git("remote", "set-url", "origin", GITHUB_REMOTE_URL);
  await reset();
}

// ── 6. A git call that never returns is refused, not passed. The scan carries
// its own wall clock, so a hung git cannot hang the hook, and "cannot read" is
// never "clean".
{
  await commit("pend.txt", "public\n", "chore: pending probe");
  const hungExec: ExecFn = (cmd, opts) =>
    new Promise<never>((_resolve, reject) => {
      // A call that ignores its timeout and never settles.
      void cmd;
      void opts;
      void reject;
    });
  const started = Date.now();
  const hit = await Promise.race([
    inspect(pushCommand(), { executor: hungExec }),
    new Promise<undefined>((res) => setTimeout(() => res(undefined), 90_000)),
  ]);
  const elapsed = Date.now() - started;
  assert(hit !== undefined, "a push whose git calls never return is refused, not passed");
  assert(hit?.verdict.kind === "unreadable", "and the refusal says the range could not be read");
  assert(elapsed < 90_000, `the scan bounded itself (${elapsed}ms) rather than hanging`);
  await reset();
}

// ── 7. No remote at all: an unreadable range refuses, never "clean".
{
  const bare = path.join(fixtureRoot, "noremote");
  await gitIn(fixtureRoot)("init", "-q", bare);
  writeFileSync(path.join(bare, "a.txt"), "hello\n", "utf8");
  const r = await scanPushRange({
    exec: gitTransport(bare),
    cwd: bare,
    ...scanOpts(pushCommand()),
  });
  assert(
    !r.scanned && r.problems.length > 0,
    "a clone with no remote reports it could not resolve the push, rather than clean",
  );
}

// ── 8–14. The range comes from the REFSPEC, not from HEAD. Each case makes
// the branch the command names dirty and HEAD's branch clean, so a scan that
// still inferred the range from HEAD would report clean and the assertion is
// red for the right reason.

// ── 8. `push origin <dirty-branch>` while HEAD sits on a clean branch.
{
  await reset();
  await commitOn("dirty-a", "d8.txt", `host = ${TERM}\n`, "chore: add the box");
  const r = await scanPushRange({
    exec,
    cwd: repo,
    remoteUrl: githubUrl,
    ...scanOpts(pushCommand("origin dirty-a")),
  });
  assert(r.scanned, "the named branch was scanned (not HEAD's clean range)");
  const hit = await inspect(pushCommand("origin dirty-a"));
  assert(hit !== undefined, "a push of a dirty branch is refused while HEAD is on a clean one");
  assert(hit?.verdict.kind === "denylist", "and for the denylist term, not for a failed read");
  await git("branch", "-D", "dirty-a");
  await reset();
}

// ── 9. An explicit destination: `dirty-branch:refs/heads/x` still names the
// dirty source, and the right-hand side is not a revision.
{
  await reset();
  await commitOn("dirty-b", "d9.txt", `host = ${TERM}\n`, "chore: add the box again");
  const hit = await inspect(pushCommand("origin dirty-b:refs/heads/x"));
  assert(hit !== undefined, "a src:dst refspec is scanned from its SOURCE");
  assert(hit?.verdict.kind === "denylist", "and refused on the term, not on a failed read");
  await git("branch", "-D", "dirty-b");
  await reset();
}

// ── 10. `HEAD:refs/heads/x` from a DIRTY detached HEAD.
{
  await reset();
  const dirty = await commit("d10.txt", `host = ${TERM}\n`, "chore: detached dirty commit");
  await git("checkout", "-q", "--detach", dirty);
  const hit = await inspect(pushCommand("origin HEAD:refs/heads/x"));
  assert(hit !== undefined, "HEAD as a refspec source is scanned from the detached commit");
  assert(hit?.verdict.kind === "denylist", "and refused on the term");
  await git("checkout", "-q", "main");
  await reset();
}

// ── 11. `--all` with one dirty branch among the clean ones.
{
  await reset();
  await commit("clean-all.txt", "public\n", "chore: a public commit on main");
  await commitOn("dirty-c", "d11.txt", `host = ${TERM}\n`, "chore: dirty on a side branch");
  const hit = await inspect(pushCommand("--all origin"));
  assert(hit !== undefined, "a push of every branch is refused when one branch is dirty");
  assert(hit?.verdict.kind === "denylist", "and refused on the term, not on a failed read");
  await git("branch", "-D", "dirty-c");
  await reset();
}

// ── 12. A CLEAN branch pushed by name is allowed, even beside a dirty one.
{
  await reset();
  await commit("clean-by-name.txt", "public\n", "chore: clean work on main");
  await commitOn("dirty-d", "d12.txt", `host = ${TERM}\n`, "chore: the dirty neighbour");
  assert(
    (await inspect(pushCommand("origin main"))) === undefined,
    "a clean branch pushed by name is allowed while a dirty branch exists",
  );
  await git("branch", "-D", "dirty-d");
  await reset();
}

// ── 13. A source that does not resolve REFUSES (fail closed).
{
  await reset();
  const hit = await inspect(pushCommand("origin no-such-branch-anywhere"));
  assert(hit !== undefined, "an unresolvable push source is refused, never assumed clean");
  assert(hit?.verdict.kind === "unreadable", "and the refusal says the range could not be read");
  assert(
    (hit?.reason ?? "").includes("PI_ENSEMBLE_PUBLIC_HYGIENE=0"),
    "and names the escape hatch so the operator can see the switch",
  );
  await reset();
}

// ── 14. A dirty commit already on a remote-tracking ref is not re-scanned:
// it is already public, and refusing it would refuse a push that publishes
// nothing new. `--not --remotes` is the whole of this behaviour.
{
  await reset();
  const dirty = await commit("d14.txt", `host = ${TERM}\n`, `chore: already public ${TERM}`);
  await remoteHas(dirty, "main");
  const r = await scanPushRange({
    exec,
    cwd: repo,
    remoteUrl: githubUrl,
    ...scanOpts(pushCommand("origin main")),
  });
  assert(
    r.scanned && r.texts.length === 0,
    "an already-pushed commit is excluded from the outgoing range",
  );
  assert(
    (await inspect(pushCommand("origin main"))) === undefined,
    "so re-pushing it is not refused for a term the world already has",
  );
  await remoteHas(baseSha, "main");
  await reset();
}

cleanup();
process.exit(exit);
