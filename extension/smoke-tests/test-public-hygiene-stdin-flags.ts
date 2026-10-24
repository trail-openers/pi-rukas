#!/usr/bin/env bun
/**
 * public-hygiene-stdin-flags (#1788 follow-up, PR #1792 adversarial round).
 *
 * ## The two bypasses this file pins
 *
 * 1. A TEXT flag whose resolved value is exactly `-` is a stdin publish, not a
 *    one-character body. The FILE flags already refuse `-` (`-F -`,
 *    `STDIN_MESSAGE_REASON`); the text readers scanned the literal `-`, found no
 *    denylist term in it and PASSED — so `gh pr comment 3 --body -` posted a
 *    body the guard never saw. All three shapes are refused (`--body -`,
 *    `--body=-`, the glued short `-b -`), in `gh`'s text flags, in `gh api`'s
 *    field flags and in git's `-m`.
 * 2. `git commit -F=x.md` / `-m=x` published unscanned. `commitCluster` declined
 *    any word containing `=` and `namesCommitMessageFlag` never set
 *    `textSurfaceNamed`, so the reader claimed nothing, the fail-closed invariant
 *    did not fire and the raw-shape backstop was gated off by `scan.publishes`.
 *    getopt takes everything after the letter as the value (with its argument
 *    separator dropped), so `-F=x.md` opens `x.md` and `-m=x` commits `x`.
 *
 * Offline, synthetic terms, a scratch denylist always; no real home path, host or
 * project name appears anywhere in this file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  commitCluster,
  commitMessageReuse,
  namesCommitMessageFlag,
} from "../src/public-hygiene-commit-flags.ts";
import { readPublicDenylist, resetDenylistCacheForTests } from "../src/public-denylist.ts";
import {
  inspectCommand,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import { STDIN_TEXT_REASON } from "../src/public-hygiene-operands.ts";
import { scanPublishSurfaces } from "../src/public-hygiene-scan.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** A synthetic term: it appears only in this file and this scratch denylist. */
const TERM = ["example", "private", "host"].join("-");

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-stdin-"));
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

const scanOf = (command: string) => scanPublishSurfaces(command, dir);

await withEnv(env, async () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. STDIN TEXT FLAGS: every one of the five forms the adversarial review
  //    named is REFUSED, and refused as UNREADABLE — not as a denylist hit on
  //    the literal `-`, which would say the wrong thing about the command.
  // ─────────────────────────────────────────────────────────────────────────
  const stdinForms: readonly { label: string; command: string }[] = [
    { label: "gh --body -", command: "gh pr comment 3 --body -" },
    { label: "gh --body=-", command: "gh pr comment 3 --body=-" },
    { label: "gh --title -", command: "gh pr create --title -" },
    { label: "gh release -n -", command: "gh release create v1 -n -" },
    { label: "gh api -F body=-", command: "gh api repos/o/r/issues/1/comments -F body=-" },
    { label: "gh api -Fbody=-", command: "gh api repos/o/r/issues/1/comments -Fbody=-" },
    { label: "git commit -m -", command: "git commit -m -" },
    { label: "git commit -m=-", command: "git commit -m=-" },
    { label: "git commit -b- glued", command: "gh pr comment 3 -b-" },
    { label: "git commit -am -", command: "git commit -am -" },
  ];
  for (const { label, command } of stdinForms) {
    const d = await ask(command);
    assert(
      blocked(d) && d?.verdict.kind === "unreadable",
      `${label} (${command}) is REFUSED as unreadable (got ${d?.verdict.kind})`,
    );
    const scan = scanOf(command);
    assert(
      scan.publishes && scan.problems.length > 0,
      `${label}: the scan records a problem for the stdin surface`,
    );
    assert(
      scan.texts.every((t) => t.text !== "-"),
      `${label}: the literal "-" is never scanned as the published text`,
    );
    assert(
      scan.problems.some((p) => p.reason === STDIN_TEXT_REASON),
      `${label}: the refusal names standard input as where the text comes from`,
    );
  }

  // The controls: a `-` that is merely a CHARACTER inside the value is ordinary
  // prose and must stay allowed (and must still be read as text).
  const dashed: readonly { label: string; command: string }[] = [
    { label: "body -x", command: `gh pr comment 3 --body "-x"` },
    { label: "body a - b", command: `gh pr comment 3 --body "a - b"` },
    { label: "short -bx", command: `gh pr comment 3 -bx` },
    { label: "body=-x", command: `gh pr comment 3 --body=-x` },
    { label: "api body=-x", command: `gh api repos/o/r/issues/1/comments -F body=-x` },
    { label: "commit -amq clean", command: `git commit -amq "clean message"` },
  ];
  for (const { label, command } of dashed) {
    const d = await ask(command);
    assert(!blocked(d), `${label} (${command}) is ALLOWED (got ${d?.reason?.slice(0, 60)})`);
    assert(
      scanOf(command).texts.some((t) => t.text.length > 0),
      `${label}: the value with a dash in it is still read as text`,
    );
  }
  // A dirty body that merely STARTS with the dash is blocked on its contents, so
  // the stdin rule did not swallow the denylist path.
  const dirtyDash = await ask(`gh pr comment 3 --body "-${TERM}"`);
  assert(
    blocked(dirtyDash) && dirtyDash?.verdict.kind === "denylist",
    `a body beginning with a dash is BLOCKED on its contents (got ${dirtyDash?.verdict.kind})`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 2. THE `=`-GLUED CLUSTER: git's short-option parser takes everything after
  //    the letter as the value — with the argument separator dropped, exactly as
  //    getopt does it.
  // ─────────────────────────────────────────────────────────────────────────
  assert(commitCluster("-m=x")?.kind === "commit message", "-m=x is a message cluster");
  assert(commitCluster("-m=x")?.tail === "x", "-m=x carries the message x (getopt drops the =)");
  assert(commitCluster("-am=x")?.tail === "x", "-am=x carries the message x");
  assert(
    commitCluster("-am==x")?.tail === "=x",
    "-am==x keeps the SECOND = — only the argument separator is dropped",
  );
  assert(commitCluster("-aF=x.md")?.kind === "commit message file", "-aF=x.md is a file cluster");
  assert(commitCluster("-aF=x.md")?.tail === "x.md", "-aF=x.md names the file x.md");
  assert(commitCluster("-amq")?.tail === "q", "-amq still glues q onto the message");
  assert(commitCluster("-ao") === undefined, "-ao is not a cluster (-o takes an operand)");
  assert(
    namesCommitMessageFlag(["git", "commit", "-F=x.md"]),
    "-F=x.md names a message surface (the backstop closes the gap the reader used to leave)",
  );
  assert(
    !namesCommitMessageFlag(["git", "commit", "--amend", "--no-edit"]),
    "--amend --no-edit still names none",
  );

  const dirtyEq = await ask(`git commit -m=${TERM}`);
  assert(
    blocked(dirtyEq) && dirtyEq?.verdict.kind === "denylist",
    `git commit -m=<term> is BLOCKED (got ${dirtyEq?.verdict.kind})`,
  );
  assert(
    scanOf(`git commit -m=${TERM}`).texts.some((t) => t.text === TERM),
    "the value is what git commits — the argument separator is not part of the message",
  );
  const dirtyEqCluster = await ask(`git commit -am=${TERM}`);
  assert(
    blocked(dirtyEqCluster) && dirtyEqCluster?.verdict.kind === "denylist",
    `git commit -am=<term> is BLOCKED (got ${dirtyEqCluster?.verdict.kind})`,
  );
  const cleanEq = await ask('git commit -m="a clean message"');
  assert(
    !blocked(cleanEq),
    `git commit -m=clean is ALLOWED (got ${cleanEq?.reason?.slice(0, 60)})`,
  );

  // `-F=x.md`: the file is named `=x.md`, so a missing one is REFUSED as
  // unreadable rather than passing with no text read.
  // `-F=x.md`: getopt opens the file named after the separator, so a missing one
  // is REFUSED as unreadable rather than passing with no text read.
  rmSync(path.join(dir, "missing.md"), { force: true });
  const missingEqFile = await ask("git commit -F=missing.md");
  assert(
    blocked(missingEqFile) && missingEqFile?.verdict.kind === "unreadable",
    `git commit -F=missing.md is REFUSED as unreadable (got ${missingEqFile?.verdict.kind})`,
  );
  assert(
    scanOf("git commit -F=missing.md").problems.length > 0,
    "the =-glued file flag records a problem rather than publishing nothing",
  );
  // The control file flag, to prove the denylist path itself still works.
  writeFileSync(path.join(dir, "dirty.md"), `mentions ${TERM} here`, "utf8");
  writeFileSync(path.join(dir, "clean.md"), "a clean message\n", "utf8");
  const dirtyEqFile = await ask("git commit -F dirty.md");
  assert(
    blocked(dirtyEqFile) && dirtyEqFile?.verdict.kind === "denylist",
    `the control file flag is BLOCKED on its CONTENTS (got ${dirtyEqFile?.verdict.kind})`,
  );
  // And when the `=`-glued file exists, its CONTENTS are what get scanned — the
  // same bytes the plain `-F` form reads, which is the whole point of taking the
  // tail the way getopt does.
  const dirtyEqFileGlued = await ask("git commit -F=dirty.md");
  assert(
    blocked(dirtyEqFileGlued) && dirtyEqFileGlued?.verdict.kind === "denylist",
    `git commit -F=dirty.md is BLOCKED on the file's CONTENTS (got ${dirtyEqFileGlued?.verdict.kind})`,
  );
  assert(
    scanOf("git commit -F=dirty.md").texts.some((t) => t.text.includes(TERM)),
    "the =-glued file is read, not the path",
  );
  const cleanEqFile = await ask("git commit -F=clean.md");
  assert(
    !blocked(cleanEqFile),
    `git commit -F=clean.md is ALLOWED (got ${cleanEqFile?.reason?.slice(0, 60)})`,
  );
  // A file whose NAME begins with `=` is what `-F==f.md` opens (the separator
  // plus a literal `=`), and the scan opens the same one.
  writeFileSync(path.join(dir, "=clean.md"), "a clean message\n", "utf8");
  const doubleEq = await ask("git commit -F==clean.md");
  assert(
    !blocked(doubleEq),
    `git commit -F==clean.md is ALLOWED (got ${doubleEq?.reason?.slice(0, 60)})`,
  );
  assert(
    scanOf("git commit -F==clean.md").texts.some((t) => t.text.includes("clean message")),
    "-F==clean.md opens the file literally named =clean.md",
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 3b. THE REUSE CLUSTER: `c`/`C` are switches to git (their operand is a
  //     COMMIT, not a message), so `-ac HEAD` bundles switches and a reuse
  //     option in one word. The cluster grammar owns those letters and reports
  //     the answer through `CommitCluster.reuses`; nothing re-derives them.
  assert(commitCluster("-ac")?.reuses === true, "-ac is a reuse cluster");
  assert(commitCluster("-aC")?.reuses === true, "-aC is a reuse cluster");
  assert(commitCluster("-qc")?.reuses === true, "-qc is a reuse cluster");
  assert(commitCluster("-amc")?.reuses === undefined, "-amc is the message `c`, not a reuse form");
  assert(commitCluster("-amc")?.tail === "c", "-amc glues c onto the message (getopt)");
  assert(commitCluster("-am")?.reuses === undefined, "-am reuses nothing");
  assert(commitCluster("-am")?.tail === "", "-am still takes the next word as its message");
  assert(commitMessageReuse(["git", "commit", "-ac", "HEAD"]), "-ac HEAD reuses a message");
  assert(
    !commitMessageReuse(["git", "commit", "-am", "msg"]),
    "-am msg reuses nothing (the control that keeps the letters from over-refusing)",
  );
  for (const command of [
    "git commit -ac HEAD",
    "git commit -aC abc123",
    "git commit -qc HEAD",
    "git commit -acm HEAD",
  ]) {
    const d = await ask(command);
    assert(
      blocked(d) && d?.verdict.kind === "unreadable",
      `${command} is REFUSED as unreadable (got ${d?.verdict.kind})`,
    );
    const scan = scanOf(command);
    assert(
      scan.problems.some((p) => p.reason.toLowerCase().includes("another commit")),
      `${command}: the refusal names the OTHER COMMIT as where the message comes from`,
    );
    assert(scan.texts.length === 0, `${command}: no text is claimed for a reused message`);
  }

  // 4. THE GLUED FILE-VALUED FLAGS — the regression table for the CRITICAL #1792
  //    closed. Once a text reader consumed a glued short form, a FILE flag's
  //    glued word was read as PROSE: the path was matched and the file's
  //    contents — the actual publish — never were. Every form below is BLOCKED on
  //    the file's CONTENTS, and every form with a missing file is REFUSED as
  //    unreadable, so a flag that names a file can never publish unchecked.
  writeFileSync(path.join(dir, "dirty.md"), `mentions ${TERM} here`, "utf8");
  writeFileSync(path.join(dir, "dirty.json"), `{"body":"${TERM}"}`);
  const gluedFileFlags: readonly { label: string; prefix: string; file: string }[] = [
    {
      label: "gh api -F glued @file",
      prefix: "gh api repos/o/r/issues/1/comments -Fbody=@",
      file: "dirty.md",
    },
    {
      label: "gh api -f glued @file",
      prefix: "gh api repos/o/r/issues/1/comments -fbody=@",
      file: "dirty.md",
    },
    {
      label: "gh api --field= glued",
      prefix: "gh api repos/o/r/issues/1/comments --field=body=@",
      file: "dirty.md",
    },
    {
      label: "gh api --input=",
      prefix: "gh api repos/o/r/issues/1/comments --input=",
      file: "dirty.json",
    },
    {
      label: "gh api -i glued",
      prefix: "gh api repos/o/r/issues/1/comments -i",
      file: "dirty.json",
    },
    { label: "git commit -F glued", prefix: "git commit -F", file: "dirty.md" },
    { label: "git commit --file=", prefix: "git commit --file=", file: "dirty.md" },
    { label: "gh pr comment -F glued", prefix: "gh pr comment 3 -F", file: "dirty.md" },
  ];
  for (const g of gluedFileFlags) {
    const dirty = await ask(`${g.prefix}${g.file}`);
    assert(
      blocked(dirty) && dirty?.verdict.kind === "denylist",
      `${g.label} is BLOCKED on the file's CONTENTS (got ${dirty?.verdict.kind})`,
    );
    const scan = scanOf(`${g.prefix}${g.file}`);
    assert(
      scan.texts.some((t) => t.text.includes(TERM)),
      `${g.label}: the scan read the FILE, not the path`,
    );
    assert(
      !scan.texts.some((t) => t.text.endsWith(g.file)),
      `${g.label}: the PATH is not scanned as the published text`,
    );
    const missing = await ask(`${g.prefix}no-such-file-${g.file}`);
    assert(
      blocked(missing) && missing?.verdict.kind === "unreadable",
      `${g.label} with a MISSING file is REFUSED as unreadable (got ${missing?.verdict.kind})`,
    );
  }

  // 5. THE CONTROLS: an ordinary cluster whose value is clean is untouched.
  // ─────────────────────────────────────────────────────────────────────────
  const allowed: readonly string[] = [
    "git commit -amq",
    "git commit -am 'clean message'",
    "git commit -aF clean.md",
    "git status -s",
    "gh pr comment 3 --body-file clean-empty.md",
  ];
  writeFileSync(path.join(dir, "clean-empty.md"), "clean\n", "utf8");
  for (const command of allowed) {
    const d = await ask(command);
    assert(!blocked(d), `${command} is ALLOWED (got ${d?.reason?.slice(0, 60)})`);
  }
});

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
