/**
 * test-hygiene-push-parse.ts — a push the scan cannot locate is a refusal, and a
 * command that pushes twice is a refusal (#2168, fail-open pair).
 *
 * Both rows came from the full-branch review, both were reproduced end to end
 * through `inspectCommand`, and both are the same shape: a scan that reports a
 * verdict for a range it never located.
 *
 * ## 1. A wrapper hides the push, and the scan answers HEAD
 *
 * `splitPushWords` read the command through the RAW segmenter while every other
 * reader of this scan — `ownPushSegment`, the verb reader, the directory probe —
 * reads it through the wrapper-stripping one. For a bare `xargs git push` the raw
 * words carried `xargs` (or `xargs -0`, `xargs -n1`) in front of the git words, so
 * the word at git's verb position was `xargs`, not the push verb: the refspec
 * reader found no push, `resolveSrcs` got no refspecs and fell into its
 * no-refspec branch, and the scan resolved HEAD — a range the command never
 * named, in a tree the stripped reader chose. `xargs git push origin <branch>`,
 * whose refspec survives the wrapper word, was correctly refused: the same family
 * refused one way and answered for HEAD the other.
 *
 * The fix the assertions pin: the words come from the same reader the segment comes
 * from, and a command the trigger calls a push in which NO git push segment can be
 * located is refused with "the push command could not be parsed" rather than
 * defaulting to HEAD. A range nobody located is not a clean range.
 *
 * Pinned in both directions, because the sentence is cheap to over-apply:
 * - with a push segment the scan cannot locate (`xargs git push`) the refusal is
 *   the parse sentence, and the range read is the HEAD read it never made;
 * - with a push segment it can locate (`xargs git push origin <branch>`) the scan
 *   still reads the refspec's commits and refuses FOR THE TERM, so the new
 *   sentence is not a wrapper ban;
 * - a command that is not a push at all (`git status`, an `echo`) is still not
 *   refused by a push sentence, which is what keeps the trigger's own over-match
 *   from becoming a refusal of prose.
 *
 * ## 2. Two pushes, one scan
 *
 * The scan answers for ONE segment — the first push's tree — so a command carrying
 * two pushes gets one scan and the second push is never read. `a && b` DOES reach
 * `b` when `a` succeeds, so the unread half was going to publish: a chain whose
 * first tree is clean and whose second carries the term was ALLOWED, the clean tree
 * scanned while the dirty one went out unscanned.
 *
 * The fix is not a second scan, it is a refusal. One push per command; an agent
 * that wants two runs two commands. The single-push control (`cd x && git push
 * origin b`) is what keeps that refusal from becoming a ban on chains, and the
 * single-push-per-segment rows (`git status && git push …`) are what keep it from
 * becoming a ban on chains that also run git.
 *
 * ## 3. A push behind a program the count could not read as git
 *
 * Counting only the segments whose stripped `argv[0]` is git counted ONE push for
 * `git push origin a && flock /tmp/l git push origin b`: the second segment's
 * program word is `flock`, `bash`, `docker` or `busybox`, and git's words sit
 * behind it. The scan then answered for the FIRST push alone, `a && b` reached
 * `b`, and the second push published unread — the same fail-open as two plain
 * pushes, hidden behind a program word. So a segment counts when its git argv
 * carries the verb (as before) OR when the trigger, asked of that segment's own
 * words, calls it a push; more than one such segment is refused with the one-push
 * sentence.
 *
 * The trigger is asked of ONE segment at a time, never of the joined command:
 * asked of the whole text it fires once per push-bearing chain and every chain
 * with any push in it would be refused, `git push origin b && git log -1`
 * included. The per-segment answers are what the row tests distinguish.
 *
 * Same fixture, same synthetic term, same pinned seams as the sibling push tests
 * (see lib/push-fixture.ts for why each seam is pinned).
 */

import path from "node:path";
import { inspectCommand } from "../src/public-hygiene-guard.ts";
import { ownPushSegment } from "../src/public-hygiene-push-dir.ts";
import { scanPushRange } from "../src/public-hygiene-push.ts";
import { commandPushes } from "../src/public-hygiene-scan.ts";
import type { ExecFn } from "../src/worktree.ts";
import {
  PUSH,
  TERM,
  baseSha,
  cleanup,
  commit,
  fixtureRoot,
  git,
  gitIn,
  gitTransport,
  githubUrl,
  inspectAt,
  pushGitCwd,
  repo,
  reset,
  scanOpts,
} from "./lib/push-fixture.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** A refusal wraps its lines, so a phrase is matched against one collapsed line. */
const flat = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ");

/** The head of a refusal, for the message of an assertion that did not hold. */
const head = (d: Awaited<ReturnType<typeof inspectAt>>): string =>
  flat(d?.reason).slice(0, 140) || "(allowed)";

/** Every git call a scan made, with the directory it ran in. */
function recorder(): { exec: ExecFn; reads: { argv: string[]; cwd: string }[] } {
  const reads: { argv: string[]; cwd: string }[] = [];
  const exec: ExecFn = (cmd, opts) => {
    if (opts?.argv) reads.push({ argv: opts.argv, cwd: opts.cwd ?? "<none>" });
    return gitTransport(repo)(cmd, opts) as Promise<{ stdout: string }>;
  };
  return { exec, reads };
}

/** Commit `content` into `dir` on its current HEAD; returns the new sha. */
async function commitIn(dir: string, file: string, content: string, message: string) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(dir, file), content, "utf8");
  await gitIn(dir)("add", file);
  await gitIn(dir)("commit", "-q", "-m", message);
  return (await gitIn(dir)("rev-parse", "HEAD")).trim();
}

/** The scan's own seam, so the problem string is pinned where it is produced. */
const scanOf = (command: string, exec: ExecFn) =>
  scanPushRange({
    exec,
    cwd: pushGitCwd(repo, command),
    toolCwd: repo,
    remoteUrl: githubUrl,
    ...scanOpts(command),
  });

// ── 1. A wrapper-hidden push answers for a range it never located ────────────
//
// The two trees are set up to disagree: the SESSION tree's HEAD carries the term
// and the worktree branch is clean at the seed. A scan that located the real push
// would read the worktree's branch and ALLOW; a scan that located nothing resolves
// HEAD and refuses for the session term. Both are refusals, so the assertions are
// about WHICH sentence and WHICH tree the reads ran in — not about the verdict.
{
  const wtClean = path.join(fixtureRoot, "wt-parse-clean");
  await git("worktree", "add", "-q", "-b", "parse-clean", wtClean);
  await gitIn(wtClean)("reset", "-q", "--hard", baseSha);
  await reset();
  // The session tree's HEAD is dirty; the pushed branch is not.
  const dirtyHead = await commit("parse-dirty.txt", `host = ${TERM}\n`, `chore: ${TERM} note`);

  // PM's passing control, in both directions. A push the scan CAN locate is scanned
  // normally, whatever else the chain runs: one `git push` segment plus a read is one
  // push, so neither new refusal touches it (this is the row that keeps the one-push
  // rule from becoming a ban on chains, and the row the whitespace-splitting word
  // reader used to fail — the tail segment's `git`/`log` arrived as refspecs of the
  // push and the routine command was refused for an unresolvable source). And the
  // same wrapper family carrying a refspec stays a scan refused FOR THE TERM, so the
  // parse sentence is not a wrapper ban.
  const dirtBranch = await git("rev-parse", "HEAD");
  await git("branch", "-f", "parse-dirty", dirtBranch.trim());
  for (const spelling of ["xargs", "xargs -0", "xargs -n1"]) {
    // ── One locatable push segment: scanned normally, and ALLOWED on a clean branch.
    const clean = `${spelling} git ${PUSH} origin parse-clean`;
    assert(commandPushes(clean) === true, `\`${clean}\` is recognised as a push`);
    const { exec, reads } = recorder();
    reads.length = 0;
    const cleanHit = await inspectAt(repo, clean, { executor: exec });
    assert(
      cleanHit === undefined,
      `\`${clean}\` is ALLOWED on a clean branch — one push segment, read through the wrapper (got ${cleanHit?.verdict.kind}: ${head(cleanHit)})`,
    );
    assert(
      !flat(cleanHit?.reason).includes("could not be parsed"),
      `\`${clean}\` carries no parse sentence (got: ${head(cleanHit)})`,
    );
    assert(
      reads.length > 0,
      `and \`${clean}\` really was scanned: the scan made git reads (${reads.length})`,
    );
    const cleanScan = await scanOf(clean, exec);
    assert(
      cleanScan.scanned && cleanScan.problems.length === 0,
      `\`scanPushRange\` scanned \`${clean}\` rather than refusing it (${JSON.stringify(cleanScan.problems).slice(0, 160)})`,
    );

    // ── The same wrapper and refspec against the DIRTY branch: a scan, refused for
    // the term, never the parse sentence.
    const twin = `${spelling} git ${PUSH} origin parse-dirty`;
    const twinHit = await inspectAt(repo, twin);
    assert(
      twinHit?.verdict.kind === "denylist",
      `\`${twin}\` is still refused FOR THE TERM — the parse sentence is not a wrapper ban (got ${twinHit?.verdict.kind}: ${head(twinHit)})`,
    );
    assert(
      !flat(twinHit?.reason).includes("could not be parsed"),
      `…and its refusal is not the parse sentence (got: ${head(twinHit)})`,
    );
  }

  // A push the trigger recognises but whose `git push` segment cannot be located in
  // the stripped words: an interpreter or a foreign runner carries the verb, so the
  // segmenter produces no git argv for it and the refspec reader has no verb word to
  // anchor a range on. This is PM's accepted fail-closed direction — refuse with the
  // parse sentence and point at the fix, never answer for HEAD (the same rule
  // `unseenPublishReason` applies to a publish the scan could not see).
  for (const hidden of [
    `busybox git ${PUSH}`,
    `docker run -v /w:/w ubuntu git ${PUSH}`,
    `eval "git ${PUSH}"`,
  ]) {
    assert(commandPushes(hidden) === true, `\`${hidden}\` is still recognised as a push`);
    const rec = recorder();
    rec.reads.length = 0;
    const hiddenHit = await inspectAt(repo, hidden, { executor: rec.exec });
    assert(
      hiddenHit !== undefined && hiddenHit.verdict.kind === "unreadable",
      `\`${hidden}\` is REFUSED rather than answered for a range nobody located (got ${hiddenHit?.verdict.kind}: ${head(hiddenHit)})`,
    );
    assert(
      flat(hiddenHit?.reason).includes("the push command could not be parsed"),
      `\`${hidden}\` is refused with the parse sentence (got: ${head(hiddenHit)})`,
    );
    assert(
      flat(hiddenHit?.reason).includes("not through a wrapper or an interpreter"),
      `…and the sentence points at the fix (got: ${head(hiddenHit)})`,
    );
    assert(
      !(hiddenHit?.reason ?? "").includes(TERM),
      `…and the refusal of \`${hidden}\` names no term — the HEAD read that produced one is the read this refuses`,
    );
    assert(
      !rec.reads.some((r) => r.argv[0] === "log"),
      `and no \`git log\` read ran for \`${hidden}\`: it was refused instead of answered from HEAD`,
    );
    const hiddenScan = await scanOf(hidden, rec.exec);
    // The bare sentence is pinned at its source: the guard's own sentence capitalises
    // it (`The push command could not be parsed…`), so an equality test here is the
    // only thing that distinguishes "this scan raised it" from "some read did".
    assert(
      !hiddenScan.scanned &&
        hiddenScan.problems.some(
          (p) =>
            p.location === "push" &&
            p.reason ===
              "the push command could not be parsed: run git push directly, not through a wrapper or an interpreter",
        ),
      `scanPushRange itself answers the parse problem for \`${hidden}\` (${JSON.stringify(hiddenScan.problems).slice(0, 160)})`,
    );
  }

  // Not a push, not refused: the trigger's regex over-matches prose on purpose,
  // and a push sentence must never be attached to a command no reader calls a push
  // and no trigger fires on.
  await reset();
  assert(
    (await inspectAt(repo, `git status`)) === undefined,
    "a command that does not push is untouched by the parse refusal",
  );
  assert(
    (await inspectAt(repo, `echo done && git log --oneline`)) === undefined,
    "…nor is a chain of non-push segments",
  );

  await git("worktree", "remove", "--force", wtClean).catch(() => {});
  await git("branch", "-D", "parse-clean").catch(() => {});
  await git("branch", "-D", "parse-dirty").catch(() => {});
  await reset();
  void dirtyHead;
}

// ── 2. One push per command ──────────────────────────────────────────────────
//
// The field shape: two pushes in one command, the first tree clean, the second
// dirty. The scan reads the first tree (the segment it answers for), finds nothing,
// and the SECOND push publishes the term unscanned. Fail closed and simple: a
// command that pushes twice is refused, whatever each tree holds.
{
  const wtA = path.join(fixtureRoot, "wt-twice-clean");
  const wtB = path.join(fixtureRoot, "wt-twice-dirty");
  await git("worktree", "add", "-q", "-b", "twice-a", wtA);
  await git("worktree", "add", "-q", "-b", "twice-b", wtB);
  await gitIn(wtA)("reset", "-q", "--hard", baseSha);
  await gitIn(wtB)("reset", "-q", "--hard", baseSha);
  await commitIn(wtB, "b-dirty.txt", `host = ${TERM}\n`, `chore: ${TERM} in the second tree`);
  await reset();

  for (const chain of [
    `git -C ${wtA} ${PUSH} && git -C ${wtB} ${PUSH}`,
    `git -C ${wtA} ${PUSH} origin twice-a && git -C ${wtB} ${PUSH} origin twice-b`,
  ]) {
    assert(commandPushes(chain) === true, `the two-push chain is recognised as a push: ${chain}`);
    const { exec, reads } = recorder();
    reads.length = 0;
    const hit = await inspectAt(repo, chain, { executor: exec });
    assert(hit !== undefined, `a command that pushes twice is REFUSED: ${chain}`);
    assert(
      flat(hit?.reason).includes("one push per command"),
      `…with the one-push-per-command sentence, not a clean scan of the first tree (got: ${head(hit)})`,
    );
    assert(
      !(hit?.reason ?? "").includes(TERM),
      "and the refusal names no term — the second tree was never read, which is the reason for refusing",
    );
    assert(
      !reads.some((r) => r.cwd === wtB),
      "and the second tree was never opened: one scan cannot answer for two pushes",
    );
    // The segment reader still answers the FIRST push of the chain — the behaviour
    // `test-public-hygiene-push-cwd.ts` pins — so the refusal is the COUNT and not
    // the segment answer having gone wrong.
    const segment = ownPushSegment({ exec, cwd: wtA, toolCwd: repo, command: chain, pushVerb: PUSH });
    assert(
      segment === wtA,
      `a two-push chain still resolves its FIRST push's directory for the segment reader (got ${String(segment)})`,
    );
  }

  // ── 3. A push hidden behind a program word ─────────────────────────────────
  //
  // Each chain carries a plain `git push` and a second push whose program word is
  // NOT git — `flock`, `bash -c`, `docker run`, `busybox`, `eval`. The count that
  // looked only at git segments saw one push, scanned the first tree, allowed, and
  // the second push published unscanned. Each row is therefore refused with the
  // one-push sentence and makes no `git log` read: the second push is never judged,
  // which is the reason for refusing rather than the reason for a verdict.
  for (const chain of [
    `git -C ${wtA} ${PUSH} origin twice-a && flock /tmp/l git -C ${wtB} ${PUSH} origin twice-b`,
    `git -C ${wtA} ${PUSH} origin twice-a && bash -c "git -C ${wtB} ${PUSH} origin twice-b"`,
    `git -C ${wtA} ${PUSH} origin twice-a && docker run img git -C ${wtB} ${PUSH} origin twice-b`,
    `git -C ${wtA} ${PUSH} origin twice-a && busybox git -C ${wtB} ${PUSH} origin twice-b`,
    `git -C ${wtA} ${PUSH} origin twice-a && eval "git -C ${wtB} ${PUSH} origin twice-b"`,
  ]) {
    assert(
      commandPushes(chain) === true,
      `the chain whose second push hides behind a program is recognised as a push: ${chain}`,
    );
    const rec = recorder();
    rec.reads.length = 0;
    const hiddenPush = await inspectAt(repo, chain, { executor: rec.exec });
    assert(
      hiddenPush !== undefined,
      `a second push behind a non-git program is REFUSED rather than published unread: ${chain}`,
    );
    assert(
      flat(hiddenPush?.reason).includes("one push per command"),
      `…with the one-push-per-command sentence (got: ${head(hiddenPush)})`,
    );
    assert(
      !(hiddenPush?.reason ?? "").includes(TERM),
      `…and the refusal names no term, because nothing was read: ${chain}`,
    );
    assert(
      !rec.reads.some((r) => r.argv[0] === "log"),
      `and no \`git log\` read ran for \`${chain}\`: the second push was refused, not judged`,
    );
  }

  // The single-push controls. Each is a chain — some of them chains that run git
  // twice — and each carries exactly one push, so the new refusal must not touch
  // them. `cd x && git push origin b` is the row the brief names; the rest are the
  // shapes a `one push` rule is most likely to over-refuse.
  const wtSingle = path.join(fixtureRoot, "wt-single");
  await git("worktree", "add", "-q", "-b", "single-ok", wtSingle);
  await gitIn(wtSingle)("reset", "-q", "--hard", baseSha);
  await reset();
  for (const [command, why] of [
    [`cd ${wtSingle} && git ${PUSH} origin single-ok`, "a push after a cd"],
    [`git status && git ${PUSH} origin single-ok`, "a push after another git command"],
    [`git ${PUSH} origin single-ok && git log --oneline -1`, "a push followed by another git command"],
    [`true; git ${PUSH} origin single-ok`, "a push after a non-git segment"],
    // The row the trigger's per-segment reading is most likely to over-refuse: the
    // tail is git but runs no push, so only ONE segment's own words call it a push.
    [`git ${PUSH} origin single-ok && git log -1`, "a push followed by a git read"],
    [`git -C ${wtA} ${PUSH} -u origin twice-a:refs/heads/twice-a`, "a -C push with a refspec"],
  ] as const) {
    assert((await inspectAt(repo, command)) === undefined, `${why} is allowed (${command})`);
  }

  await git("worktree", "remove", "--force", wtA).catch(() => {});
  await git("worktree", "remove", "--force", wtB).catch(() => {});
  await git("worktree", "remove", "--force", wtSingle).catch(() => {});
  await git("branch", "-D", "twice-a").catch(() => {});
  await git("branch", "-D", "twice-b").catch(() => {});
  await git("branch", "-D", "single-ok").catch(() => {});
  await reset();
}

cleanup();
process.exit(exit);
