/**
 * test-public-hygiene-push-cwd.ts — the DIRECTORY a push scan reads (#2168).
 *
 * `test-public-hygiene-push.ts` pins that the RANGE comes from the refspec; a
 * scan that reads the right refspec in the WRONG tree is the same bug wearing a
 * different hat, and it was reported from the field as
 * `git -C <repo>/.worktrees/<wt> push -u origin <branch>` being refused for a
 * source that could not be resolved. Each case here puts the session cwd in the
 * main checkout and the push's `-C` target in a linked worktree whose HEAD
 * differs from the session tree's, and pins the `cwd` every git read actually
 * ran with — a verdict alone cannot tell the two trees apart when one clone
 * holds both branches (`rev-parse <branch>` answers in either), so the recorded
 * argv is the only evidence that the scan asked git in the worktree.
 *
 * Same fixture, same synthetic terms, same pinned denylist env as the sibling
 * file (see lib/push-fixture.ts for why each seam is pinned).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { ownPushSegment } from "../src/public-hygiene-push-dir.ts";
import { scanPushRange } from "../src/public-hygiene-push.ts";
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

// ── 15–20. The `-C <worktree>` shapes: the DIRECTORY the scan reads, not just
// the range it names. Blocks 8–14 pin that the range comes from the refspec; a
// scan that reads the right refspec in the WRONG tree is the same bug wearing a
// different hat, and it was reported from the field as
// `git -C <repo>/.worktrees/<wt> push -u origin <branch>` being refused for a
// source that could not be resolved. Each case below puts the session cwd in
// the main checkout and the push's `-C` target in a linked worktree whose HEAD
// differs from the session tree's, and pins the `cwd` every git read actually
// ran with — a verdict alone cannot tell the two trees apart when one clone
// holds both branches (`rev-parse <branch>` answers in either), so the recorded
// argv is the only evidence that the scan asked git in the worktree.
{
  /** Every git call the scan made, with the directory it ran in. */
  const reads: { argv: string[]; cwd: string }[] = [];
  const recordingExec: ExecFn = (cmd, opts) => {
    if (opts?.argv) reads.push({ argv: opts.argv, cwd: opts.cwd ?? "<none>" });
    return gitTransport(opts?.cwd ?? repo)(cmd, opts) as Promise<{ stdout: string }>;
  };
  const readsOf = (match: (argv: string[]) => boolean): { argv: string[]; cwd: string }[] =>
    reads.filter((r) => match(r.argv));

  /** A refusal wraps its lines, so a phrase is matched against one collapsed line. */
  const flatReason = (d: { reason?: string } | undefined): string =>
    (d?.reason ?? "").replace(/\s+/g, " ");

  /** Make commits in `dir` (a worktree or the clone) on its current HEAD. */
  async function commitIn(dir: string, file: string, content: string, message: string) {
    writeFileSync(path.join(dir, file), content, "utf8");
    await gitIn(dir)("add", file);
    await gitIn(dir)("commit", "-q", "-m", message);
    return (await gitIn(dir)("rev-parse", "HEAD")).trim();
  }

  const wtDir = path.join(fixtureRoot, "wt-15");
  await git("worktree", "add", "-q", "-b", "wt-branch", wtDir);
  // The worktree's branch is dirty and the SESSION tree's HEAD is clean: the
  // shape that separates "read the worktree" from "read where the tool call sat".
  const wtDirty = await commitIn(wtDir, "w15.txt", `host = ${TERM}\n`, `chore: ${TERM} note`);

  for (const spelling of [
    (wt: string) => `git -C ${wt} ${PUSH} -u origin wt-branch`,
    (wt: string) => `git -C ${wt} ${PUSH} origin wt-branch`,
    (wt: string) => `env FOO=1 git -C ${wt} ${PUSH} -u origin wt-branch`,
    (wt: string) => `FOO=1 git -C ${wt} ${PUSH} origin wt-branch`,
    (wt: string) => `git -c user.name=t -C ${wt} ${PUSH} origin wt-branch`,
  ]) {
    await reset();
    reads.length = 0;
    const command = spelling(wtDir);
    // The tool cwd is deliberately NOT threaded in here: the registered guard
    // derives it from the command, and a scan handed the worktree by its caller
    // would pass for a `-C` reader that still resolved the session directory.
    const r = await scanPushRange({
      exec: recordingExec,
      cwd: pushGitCwd(repo, command),
      remoteUrl: githubUrl,
      ...scanOpts(command),
    });
    assert(
      r.scanned && r.texts.some((t) => t.text.includes(TERM)),
      "`-C <worktree>` names a branch that resolves IN the worktree, and is scanned (#2168)",
    );
    assert(
      reads.length > 0 && reads.every((x) => x.cwd === wtDir),
      "and every git read of that scan ran in the `-C` directory, not the session cwd",
    );
    const hit = await inspectAt(repo, command, { executor: recordingExec });
    assert(
      hit?.verdict.kind === "denylist",
      "the guard refuses it for the TERM, never for an unresolvable source",
    );
  }

  // A no-refspec push resolves HEAD where the git runs: HEAD is dirty in the
  // worktree and clean in the session tree, so a scan that read the session
  // HEAD would call this clean.
  await reset();
  reads.length = 0;
  const noRefSpec = `git -C ${wtDir} ${PUSH}`;
  const headScan = await scanPushRange({
    exec: recordingExec,
    cwd: pushGitCwd(repo, noRefSpec),
    remoteUrl: githubUrl,
    ...scanOpts(noRefSpec),
  });
  assert(
    headScan.scanned && headScan.texts.some((t) => t.text.includes(TERM)),
    "a `-C <worktree>` push with NO refspec resolves HEAD in the worktree (#2168)",
  );
  const headReads = readsOf((a) => a[0] === "rev-parse");
  assert(
    headReads.length > 0 && headReads.every((r) => r.cwd === wtDir),
    "and the HEAD resolution itself was asked of git IN the worktree (H4)",
  );
  const headHit = await inspectAt(repo, noRefSpec, { executor: recordingExec });
  assert(
    headHit?.verdict.kind === "denylist",
    "so the dirty worktree HEAD is refused, which a session-HEAD read could not see",
  );
  assert(
    headHit !== undefined && !headHit.reason.includes(TERM),
    "and the refusal still carries no term",
  );

  // The inverse: HEAD clean in the worktree, dirty in the session tree. A scan
  // that read the session HEAD would refuse a push that publishes nothing dirty.
  await reset();
  await gitIn(wtDir)("reset", "-q", "--hard", baseSha);
  await commit("session-dirty.txt", `host = ${TERM}\n`, `chore: session side ${TERM}`);
  const cleanWt = `git -C ${wtDir} ${PUSH}`;
  assert(
    (await inspectAt(repo, cleanWt)) === undefined,
    "a clean worktree HEAD is allowed while the SESSION tree's HEAD is dirty (#2168, inverse)",
  );
  await reset();

  // Fail-closed stays fail-closed: a source absent from the worktree and from
  // the clone is refused with the source sentence, and a `-C` target that is no
  // repository at all is refused with a sentence that NAMES the directory — not
  // the "(timed out)" remote-read sentence a wrong directory used to hide behind
  // (H3), and never allowed.
  await reset();
  const missing = `git -C ${wtDir} ${PUSH} origin no-such-branch-anywhere`;
  const missingHit = await inspectAt(repo, missing);
  assert(
    missingHit?.verdict.kind === "unreadable",
    "a source that resolves in neither tree is still refused (fail closed)",
  );
  assert(
    (missingHit?.reason ?? "").includes("a push source could not be resolved to a commit"),
    "and the refusal names the push source, not some other read",
  );
  assert(
    (missingHit?.reason ?? "").includes("PI_ENSEMBLE_PUBLIC_HYGIENE=0"),
    "and names the escape hatch",
  );
  const bogus = `git -C ${path.join(fixtureRoot, "not-a-repo")} ${PUSH} origin main`;
  const bogusHit = await inspectAt(repo, bogus);
  assert(
    bogusHit?.verdict.kind === "unreadable",
    "a `-C` target that is no repository is refused, never allowed",
  );
  assert(
    (bogusHit?.reason ?? "").includes("not-a-repo"),
    "and the refusal names the directory that could not be read, which is what an agent can act on (H3)",
  );
  assert(
    !(bogusHit?.reason ?? "").includes("timed out"),
    "and it is not reported as the timed-out remote read it used to look like",
  );

  // A quoted positional with a space is ONE source, not two (H8): the words come
  // from the segmenter, so the scan must ask git for the whole ref and refuse
  // when it is not there rather than resolving half of it.
  const quoted = `git -C ${wtDir} ${PUSH} origin 'feat/two words'`;
  reads.length = 0;
  const quotedHit = await inspectAt(repo, quoted, { executor: recordingExec });
  assert(
    quotedHit?.verdict.kind === "unreadable",
    "a quoted positional branch is read as one source and refused when it does not resolve",
  );
  // The revision asked of git must carry the WHOLE ref, space included. A
  // whitespace split would have asked for `feat/two` and refused a push whose
  // real source it had never read, so the suffix is checked too: the peel belongs
  // to the ref, not to its last word.
  assert(
    readsOf((a) => a[0] === "rev-parse" && a[1] === "--verify").some(
      (r) => r.argv[3] === "feat/two words^{commit}",
    ),
    "and the whole quoted ref, space included, was the revision git was asked for (H8)",
  );

  // ── The FIRST push of a two-push chain, not the last (#2168).
  //
  // `pushGitCwd` answers the LAST segment of a chain — right for the directory a
  // shell leaves behind, wrong for a scan, because `a && b` never reaches `b`
  // once `a` is refused. `ownPushSegment` answers the FIRST push segment, and the
  // only evidence that separates the two readers is which tree the git reads
  // actually ran in when the two pushes name two different `-C`s. `pushGitCwd`
  // answers the SECOND directory for both commands below, so a scan built on it
  // fails these assertions red — that is what makes them evidence rather than a
  // re-assertion of the same answer twice.
  //
  // What is pinned is the DIRECTORY, never the verdict. A chain that names two
  // trees is refused either way (see the note under direction 2 for the
  // refspec reader's reason), and a refuse-everything scan would "refuse" too,
  // so the verdict carries no information here. The recorded argv does: it shows
  // which clone git was asked in, and that is the thing H4 was about.
  const wtA = path.join(fixtureRoot, "wt-first");
  const wtB = path.join(fixtureRoot, "wt-second");
  await git("worktree", "add", "-q", "-b", "first-branch", wtA);
  await git("worktree", "add", "-q", "-b", "second-branch", wtB);
  const twoPushes = `git -C ${wtA} ${PUSH} origin first-branch && git -C ${wtB} ${PUSH} origin second-branch`;
  // The chain's last segment resolves elsewhere, so the assertions below can tell
  // a first-segment reader from a last-segment one at all.
  assert(
    pushGitCwd(repo, twoPushes) === wtB,
    "the chain's LAST -C is a different directory from its first (so the blocks below are a real distinction)",
  );
  // Direction 1: FIRST tree dirty, second clean — the field report's shape.
  const firstDirty = await commitIn(
    wtA,
    "f.txt",
    `host = ${TERM}\n`,
    `chore: ${TERM} in the first tree`,
  );
  await gitIn(wtB)("reset", "-q", "--hard", baseSha);
  await reset();
  reads.length = 0;
  const twoPushesHit = await inspectAt(repo, twoPushes, { executor: recordingExec });
  // A command that pushes twice is now REFUSED before the scan is built, so no tree
  // is read at all: one scan of the first tree cannot answer for the second push, and
  // `a && b` reaches `b` once `a` succeeds. The recorded argv is still the evidence —
  // it is now the evidence that the scan read NOTHING, which is what a scan that could
  // not locate one range per push must do (#2168).
  assert(
    twoPushesHit !== undefined &&
      flatReason(twoPushesHit).includes("one push per command"),
    "a two-push chain is refused with the one-push-per-command sentence (H4/H1)",
  );
  assert(
    reads.length === 0,
    `and no git read ran for the chain at all (${reads.length}) — neither tree was judged`,
  );
  // `ownPushSegment` still answers the FIRST push's directory for the chain, which is
  // the guarantee the earlier fix established and the reason the refusal is about the
  // COUNT and not about a segment reader that lost the first push.
  assert(
    ownPushSegment({
      exec: recordingExec,
      cwd: wtA,
      toolCwd: repo,
      command: twoPushes,
      pushVerb: PUSH,
    }) === wtA,
    "and the segment reader still resolves the FIRST push's `-C`, not the last (H4)",
  );
  // Direction 1 control: the FIRST tree's push on its own is read and refused FOR THE
  // TERM, so the reads the scan makes are real reads and the chain refusal above is
  // the chain, not an early bail-out.
  reads.length = 0;
  const soloDirty = await inspectAt(repo, `git -C ${wtA} ${PUSH} origin first-branch`, {
    executor: recordingExec,
  });
  assert(
    soloDirty?.verdict.kind === "denylist",
    "the same first tree pushed on its own is refused FOR THE TERM — so the reads are a working scan, not an early bail-out",
  );
  assert(
    reads.length > 0 &&
      readsOf((a) => a[0] === "log").length > 0 &&
      readsOf((a) => a[0] === "log").every((r) => r.cwd === wtA),
    "and that scan's `git log` commit reads — the reads that decide the verdict — ran in the first tree too (H4)",
  );
  // Direction 2: FIRST tree clean, SECOND tree dirty. Same refusal, other side: the
  // dirty second tree is no longer reachable through a clean first tree's verdict.
  await gitIn(wtA)("reset", "-q", "--hard", baseSha);
  await commitIn(wtB, "s.txt", `host = ${TERM}\n`, `chore: ${TERM} in the second tree`);
  await reset();
  reads.length = 0;
  const secondDirty = await inspectAt(repo, twoPushes, { executor: recordingExec });
  assert(
    secondDirty !== undefined &&
      flatReason(secondDirty).includes("one push per command"),
    "a chain whose FIRST push is clean and whose SECOND carries the term is refused, never scanned clean (#2168, mirror)",
  );
  assert(
    reads.length === 0 && !reads.some((r) => r.cwd === wtB),
    "and the dirty second tree was never read — the verdict it would have earned is the reason for refusing",
  );
  // The single-push control for the mirror: the same clean first tree, pushed on
  // its own, is allowed. So the refusal above is the chain, not the trees.
  reads.length = 0;
  assert(
    (await inspectAt(repo, `git -C ${wtA} ${PUSH} origin first-branch`, {
      executor: recordingExec,
    })) === undefined,
    "the FIRST tree's push on its own is allowed — so the chain refusal above is the chain, and the control's reads were real reads",
  );
  await git("worktree", "remove", "--force", wtA).catch(() => {});
  await git("worktree", "remove", "--force", wtB).catch(() => {});
  await git("branch", "-D", "first-branch").catch(() => {});
  await git("branch", "-D", "second-branch").catch(() => {});
  await gitIn(wtA)("reset", "-q", "--hard", firstDirty).catch(() => {});
  await gitIn(wtDir)("reset", "-q", "--hard", wtDirty);
  await reset();

  for (const pair of [
    `--git-dir=${path.join(wtDir, ".git")} --work-tree=${wtDir}`,
    `--git-dir ${path.join(wtDir, ".git")} --work-tree ${wtDir}`,
    `--git-dir=${wtDir}`,
    `--work-tree=${wtDir}`,
  ]) {
    await reset();
    const cmd = `git ${pair} ${PUSH} origin wt-branch`;
    const refused = await inspectAt(repo, cmd);
    assert(
      refused?.verdict.kind === "unreadable" &&
        (refused.reason.includes("--git-dir") || refused.reason.includes("--work-tree")),
      `a push with \`${pair}\` is refused with a message naming the flag, not scanned in the session cwd (H7)`,
    );
  }

  await git("worktree", "remove", "--force", wtDir).catch(() => {});
  await git("branch", "-D", "wt-branch").catch(() => {});
  await reset();
}

cleanup();
process.exit(exit);
