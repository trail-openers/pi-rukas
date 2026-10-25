#!/usr/bin/env bun
/**
 * public-hygiene-commit-reuse-verb (#1820) — the reuse reader asked EVERY word of
 * the argv, so git's OWN global `-C <dir>` was read as `git commit -C <commit>`.
 *
 * ## The defect this file pins
 *
 * git reads its global options BEFORE the verb: `-C <path>`, `-c k=v`,
 * `--git-dir=…`, `--work-tree …`. Two of them are spelled exactly like
 * `git commit`'s message-reuse letters, so the scan's word loop saw a reuse flag
 * in every command of the shape:
 *
 *     git -C /some/worktree commit -m 'a clean message'
 *
 * and refused it as "message comes from another commit". Since v0.14.17 that has
 * held EVERY agent's `git -C <path> commit -m …`, which is the form the /work
 * driver and every worktree dispatch writes. The repro the issue carried:
 *
 *     commitMessageReuse(["git", "-C", "/tmp", "commit", "-m", "hello"]) === true
 *
 * ## The rule now
 *
 * Positional: the words before `commit` are git's, the words after it are
 * commit's. The verb is located with `gitVerb`, the hygiene guard's existing
 * skipper for git's globals (it is the one place that knows `-C <dir>` and
 * `-c k=v` take their value as a SEPARATE word and must consume their follower).
 *
 * ## What must NOT regress
 *
 * A real reuse form still refuses, INCLUDING behind global options
 * (`git -C /x commit -C HEAD`), and a command whose verb cannot be located at all
 * still answers REUSE — the fail-closed side. A gate that only proved the fix
 * would pass by declaring everything non-reuse, so both directions are asserted.
 *
 * Offline, synthetic paths and terms only; no real home path, host or project
 * name appears anywhere in this file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPublicDenylist, resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { commitCluster } from "../src/public-hygiene-commit-flags.ts";
import { commitMessageReuse } from "../src/public-hygiene-commit-reuse.ts";
import {
  inspectCommand,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import { scanPublishSurfaces } from "../src/public-hygiene-scan.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** A synthetic term: it appears only in this file and this scratch denylist. */
const TERM = ["example", "private", "host"].join("-");

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-reuse-verb-"));
const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, `# synthetic list\n${TERM}\n`, "utf8");
const env = { PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath };

const PUSH = ["pu", "sh"].join("");
const noExec: ExecFn | undefined = undefined;

async function ask(command: string) {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  resetVisibilityCacheForTests();
  return inspectCommand(command, dir, noExec, () => readPublicDenylist(env), {
    pushVerb: PUSH,
    remoteUrl: async () => "https://github.com/example-owner/example-repo.git",
  });
}

/** Blocked = refused at all (a denylist hit or an unreadable surface). */
const blocked = (d: Awaited<ReturnType<typeof ask>>): boolean => d !== undefined;

/** argv for a command line, the shape the scan hands the reuse reader. */
const argvOf = (command: string): string[] => command.split(" ");

await withEnv(env, async () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. THE DEFECT: git's own globals before the verb are NOT commit flags.
  // ─────────────────────────────────────────────────────────────────────────
  const clean: readonly string[] = [
    "git -C /tmp commit -m hello",
    "git -C /tmp/repo commit -m 'a clean message'",
    "git -c user.name=a commit -m x",
    "git --git-dir=/x/.git commit -m x",
    "git --work-tree /x commit -m x",
    "git -C /a -c a.b=c --git-dir=/x/.git commit -m x",
  ];
  for (const command of clean) {
    assert(
      !commitMessageReuse(argvOf(command)),
      `${command} is NOT a reuse form (git's globals sit before the verb)`,
    );
    const d = await ask(command);
    assert(!blocked(d), `${command} is ALLOWED (got ${d?.reason?.slice(0, 70)})`);
  }

  // The exact repro from the issue, asserted as the primitive rather than only
  // through the guard: a `-C` that is git's must never reach the reuse rule.
  assert(
    commitMessageReuse(["git", "-C", "/tmp", "commit", "-m", "hello"]) === false,
    "the #1820 repro: git -C /tmp commit -m hello is not reuse",
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 2. NO REGRESSION: a real reuse form still refuses, with globals in front.
  // ─────────────────────────────────────────────────────────────────────────
  const reuse: readonly string[] = [
    "git commit -C HEAD",
    "git commit -c HEAD",
    "git commit -Cabc123",
    "git commit --reuse-message=HEAD",
    "git commit --reedit-message HEAD~1",
    "git commit --squash abc123",
    "git commit --fixup=amend:abc123",
    "git commit -ac HEAD",
    // The load-bearing pair: globals FIRST, the commit reuse flag after the verb.
    "git -C /x commit -C HEAD",
    "git -c user.name=a commit -c HEAD",
    "git --git-dir=/x/.git commit --reuse-message=HEAD",
    "git -C /x --work-tree /y commit --squash abc123",
  ];
  for (const command of reuse) {
    assert(commitMessageReuse(argvOf(command)), `${command} IS a reuse form`);
    const d = await ask(command);
    assert(
      blocked(d) && d?.verdict.kind === "unreadable",
      `${command} is REFUSED as unreadable (got ${d?.verdict.kind})`,
    );
    const scan = scanPublishSurfaces(command, dir);
    assert(
      scan.problems.some((p) => p.reason.toLowerCase().includes("another commit")),
      `${command}: the refusal names the OTHER COMMIT as where the message comes from`,
    );
    assert(scan.texts.length === 0, `${command}: no text is claimed for a reused message`);
  }

  // A denylist term carried by a clean commit behind git's `-C` is still BLOCKED:
  // the fix moved the boundary, it did not move the scan off the message.
  const dirty = await ask(`git -C ${dir} commit -m ${TERM}`);
  assert(
    blocked(dirty) && dirty?.verdict.kind === "denylist",
    `git -C <dir> commit -m <term> is BLOCKED on the term (got ${dirty?.verdict.kind})`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 3. FAIL-CLOSED: no locatable commit verb keeps today's answer — REUSE.
  // ─────────────────────────────────────────────────────────────────────────
  const unlocatable: readonly string[][] = [
    [],
    ["git"],
    ["git", "-C"],
    ["git", "-C", "/tmp"],
    ["git", "-c"],
    ["git", "--git-dir=/x/.git"],
    // A git command that is not a commit: a NON-git argv and an argv whose globals
    // never terminate have no publish to judge, so they answer REUSE and any scan
    // that reached them refuses. A recognized non-commit answers the same way today
    // only because `scanGitCommit` has already decided the command publishes and
    // will not reach this reader for it; the control below pins that split, so a
    // future reader that asked about `status` would be caught by it rather than by
    // a claim here.
    ["npm", "run", "commit"],
    ["docker", "run", "image", "commit", "-C", "HEAD"],
  ];
  for (const argv of unlocatable) {
    assert(
      commitMessageReuse(argv) === true,
      `${JSON.stringify(argv)} with no locatable commit verb is REUSE (fail closed)`,
    );
  }

  // The cluster grammar still owns what a bundled word means, and that ownership
  // is what this reader must not duplicate: a cluster of switches carrying a reuse
  // letter (`-ac HEAD`) is reuse, and one whose value option swallowed its tail
  // (`-amc` — `c` is the message) is not. Asserted through the cluster owner, so
  // this file cannot drift from it.
  assert(commitCluster("-ac")?.reuses === true, "-ac is a switch cluster carrying a reuse letter");
  assert(commitMessageReuse(["git", "commit", "-ac", "HEAD"]), "-ac HEAD reuses a message");
  assert(
    commitMessageReuse(["git", "commit", "-amc"]) === (commitCluster("-amc")?.reuses ?? false),
    "the reuse reader asks the cluster owner rather than re-deriving letters (the #1792 invariant)",
  );

  // The verb must be git's own, so a `commit` that is an OPERAND of another
  // program claims nothing: `docker run image commit …` is not a git commit and
  // the scan leaves it alone (the primitive above refuses it fail-closed; the
  // scan must not invent a publish for a command that never ran git).
  assert(
    !scanPublishSurfaces("docker run image commit -C HEAD", dir).publishes,
    "a non-git argv whose operand is the word commit publishes nothing",
  );
  // The split above, pinned: `git status` carries no publish verb, so the scan
  // never asks the reuse reader about it and the command stays ordinary even
  // though the primitive alone would have answered REUSE.
  const status = scanPublishSurfaces("git status -s", dir);
  assert(!status.publishes, "git status publishes nothing");
  assert(!status.problems.some((p) => p.reason.includes("another commit")), "git status is not refused as reuse");
  const statusVerdict = await ask("git status -s");
  assert(!blocked(statusVerdict), `git status -s is ALLOWED (got ${statusVerdict?.reason?.slice(0, 60)})`);
});

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
