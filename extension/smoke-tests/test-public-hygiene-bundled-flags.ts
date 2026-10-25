#!/usr/bin/env bun
/**
 * public-hygiene-bundled-flags (#1792 follow-up) — a bundled git commit short
 * cluster carries its message past BOTH the reader and the backstop.
 *
 * ## The bypass this file pins
 *
 * `flagEndsAt` matches a word that STARTS with the flag, and the backstop's
 * `GIT_COMMIT_MESSAGE_SHAPE` required a delimiter after `-m`. So `git commit
 * -amTERM`, `git commit -am TERM` and `git commit -qmTERM` published unchecked
 * while `git commit -a -m TERM` was blocked — getopt's bundling was the one
 * shape neither half of the guard spoke. Three rules, three blocks:
 *
 * 1. THE CLUSTER: `-am<term>`, `-am <term>`, `-qm<term>`, `-amq<term>` (the `q`
 *    is part of the message, exactly as getopt parses it), the same behind
 *    `sudo`, behind an absolute `git` path, and a path-prefixed `gh`.
 * 2. UNREADABLE: `-aF -` (stdin) and the `-c`/`-C` message-reuse forms are
 *    refused, not passed — the text they publish exists somewhere the guard
 *    does not read.
 * 3. THE CONTROLS: the clean equivalents are ALLOWED and an ordinary git
 *    command is untouched. A gate that refused everything would pass blocks 1
 *    and 2 and fail nothing.
 *
 * Offline, synthetic terms, a scratch denylist always; no real home path, host
 * or project name appears anywhere in this file.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPublicDenylist, resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { commitCluster, namesCommitMessageFlag } from "../src/public-hygiene-commit-flags.ts";
import { commitMessageReuse } from "../src/public-hygiene-commit-reuse.ts";
import {
  inspectCommand,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import {
  GIT_COMMIT_MESSAGE_SHAPE,
  looksLikePublish,
} from "../src/public-hygiene-publish-shapes.ts";
import { scanPublishSurfaces } from "../src/public-hygiene-scan.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** A synthetic term: it appears only in this file and this scratch denylist. */
const TERM = ["example", "private", "host"].join("-");

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-bundled-"));
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

const messages = (command: string): string[] =>
  scanPublishSurfaces(command, dir).texts.map((t) => t.text);

await withEnv(env, async () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. THE CLUSTER: a bundled `-am` / `-qm` carries the message, and the
  //    letters after `m` belong to the message.
  // ─────────────────────────────────────────────────────────────────────────
  const blockedCommands: readonly string[] = [
    `git commit -am${TERM}`,
    `git commit -am ${TERM}`,
    `git commit -qm${TERM}`,
    `git commit -amq${TERM}`,
    `sudo git commit -am ${TERM}`,
    `/usr/bin/git commit -am${TERM}`,
    `/usr/local/bin/gh pr comment 3 --body ${TERM}`,
  ];
  for (const command of blockedCommands) {
    const d = await ask(command);
    assert(
      blocked(d) && d?.verdict.kind === "denylist",
      `${command} is BLOCKED against the denylist (got ${d?.verdict.kind})`,
    );
  }

  // The reader, not just the verdict: `-amq<term>` publishes `q<term>` because
  // getopt hangs the `q` on the `m` — a reader that treated the cluster as
  // switches and took the NEXT word would scan the wrong text entirely.
  assert(
    messages(`git commit -am${TERM}`).includes(TERM),
    "-am<term> is read as the commit message itself",
  );
  assert(
    messages(`git commit -amq${TERM}`).includes(`q${TERM}`),
    "-amq<term> is read with the q as part of the message",
  );
  assert(
    messages(`git commit -qm${TERM}`).includes(TERM),
    "-qm<term> is read as the commit message itself",
  );
  assert(
    scanPublishSurfaces(`git commit -am${TERM}`, dir).publishes,
    "the scan itself (not only the guard) sees a clustered publish",
  );

  // The backstop shape: a cluster with no delimiter at all still counts as a
  // commit-message publish shape, so an unreadable cluster cannot be a pass.
  for (const shape of ["git commit -am", "git commit -qmx", "git commit -aF x"]) {
    assert(GIT_COMMIT_MESSAGE_SHAPE.test(shape), `${shape} is a commit-message shape`);
    assert(looksLikePublish(shape), `${shape} looks like a publish`);
  }

  // The cluster reader's own contract, fail-closed: a letter that is no git
  // commit option makes the whole cluster unrecognised (the backstop then
  // catches it as an unreadable publish). An `=` is NOT what unrecognises a word
  // — getopt takes everything after the letter as the value, so `-am=x` IS a
  // cluster whose message is `=x` (the `-F=` fix, PR #1792 follow-up).
  assert(commitCluster("-am")?.kind === "commit message", "-am is a message cluster");
  assert(commitCluster("-aF")?.kind === "commit message file", "-aF is a file cluster");
  assert(commitCluster("-amq")?.tail === "q", "-amq glues q onto the message");
  assert(commitCluster("-ao") === undefined, "-ao is not a cluster (-o takes an operand)");
  assert(commitCluster("-am=x")?.tail === "x", "-am=x is a cluster whose message is x");
  // The reuse reader names the forms whose message lives in ANOTHER commit, and
  // excludes by name the `--no-*` switches that merely re-state the current one.
  assert(commitMessageReuse(["git", "commit", "-c", "HEAD~1", "--amend"]), "-c reuses a message");
  assert(commitMessageReuse(["git", "commit", "-C", "abc123"]), "-C <ref> reuses a message");
  assert(commitMessageReuse(["git", "commit", "-Ca"]), "-C<a> glued reuses a message");
  assert(
    commitMessageReuse(["git", "commit", "--reuse-message=HEAD~1"]),
    "--reuse-message= reuses",
  );
  assert(
    !commitMessageReuse(["git", "commit", "--amend", "--no-edit"]),
    "--no-edit reuses nothing",
  );
  assert(namesCommitMessageFlag(["git", "commit", "-amx"]), "-amx names a message flag");
  assert(
    !namesCommitMessageFlag(["git", "commit", "--amend", "--no-edit"]),
    "--amend --no-edit names none",
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 2. UNREADABLE: the message is not in the command at all.
  // ─────────────────────────────────────────────────────────────────────────
  const unreadable: readonly { label: string; command: string }[] = [
    { label: "a message from stdin", command: "git commit -aF -" },
    { label: "a reused message (-c)", command: "git commit -c HEAD~1 --amend" },
    { label: "a reused message (-C)", command: "git commit -C abc123" },
  ];
  for (const { label, command } of unreadable) {
    const d = await ask(command);
    assert(
      blocked(d) && d?.verdict.kind === "unreadable",
      `${label} (${command}) is REFUSED as unreadable (got ${d?.verdict.kind})`,
    );
    const scan = scanPublishSurfaces(command, dir);
    assert(
      scan.problems.length > 0 && scan.texts.length === 0,
      `${label}: the scan records a problem and reads no text`,
    );
  }
  // The reuse refusal names WHERE the message comes from — an operator reading
  // it must not conclude the message was empty.
  const reuse = await ask("git commit -C abc123");
  assert(
    (reuse?.reason ?? "").toLowerCase().includes("commit"),
    "the reuse refusal names the commit the message comes from",
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 3. THE CONTROLS: clean equivalents allowed, ordinary commands untouched.
  // ─────────────────────────────────────────────────────────────────────────
  const allowed: readonly string[] = [
    `git commit -am "clean message"`,
    "git commit -a -m clean",
    "git status -s",
    "git log -n 5",
  ];
  for (const command of allowed) {
    const d = await ask(command);
    assert(!blocked(d), `${command} is ALLOWED (got ${d?.reason?.slice(0, 60)})`);
  }
  assert(!looksLikePublish("git status -s"), "git status -s is not a publish shape");
  assert(!looksLikePublish("git commit -a"), "git commit -a with no message flag is not");
  assert(!looksLikePublish("git commit -o x"), "a cluster with no m/F is not a publish shape");

  // ──────────────────────────────────────────────────────────────────────
  // 4. GLUED FILE FLAGS (#1792 follow-up, item 1). Once `textFlagValue` consumed
  //    a glued short form, a FILE flag's glued word was read as PROSE: the path
  //    was matched and the file's contents — the actual publish — never were.
  //    Every form of every file flag is read through `readPublishFile`: dirty
  //    BLOCKED, clean ALLOWED, unreadable REFUSED.
  // ──────────────────────────────────────────────────────────────────────
  writeFileSync(path.join(dir, "dirty.md"), `mentions ${TERM} here`, "utf8");
  writeFileSync(path.join(dir, "clean.md"), "a clean body\n", "utf8");
  const fileForms: readonly { label: string; command: string; dirty: boolean }[] = [
    {
      label: "gh --body-file separate",
      command: "gh pr comment 3 --body-file dirty.md",
      dirty: true,
    },
    { label: "gh --body-file=", command: "gh pr comment 3 --body-file=dirty.md", dirty: true },
    { label: "gh -F glued", command: "gh pr comment 3 -Fdirty.md", dirty: true },
    { label: "gh -F separate", command: "gh pr comment 3 -F dirty.md", dirty: true },
    { label: "gh -F glued clean", command: "gh pr comment 3 -Fclean.md", dirty: false },
    {
      label: "gh release --notes-file=",
      command: "gh release create 1.0 --notes-file=dirty.md",
      dirty: true,
    },
    { label: "gh release -n (notes file)", command: "gh release edit 1.0 -ndirty.md", dirty: true },
    {
      label: "gh api -F glued @file",
      command: "gh api repos/o/r/issues/1/comments -Fbody=@dirty.md",
      dirty: true,
    },
    {
      label: "gh api --input separate",
      command: "gh api repos/o/r/issues/1/comments --input dirty.json",
      dirty: true,
    },
    {
      label: "gh api --input=",
      command: "gh api repos/o/r/issues/1/comments --input=dirty.json",
      dirty: true,
    },
    {
      label: "gh api -i glued",
      command: "gh api repos/o/r/issues/1/comments -idrty.json",
      dirty: true,
    },
    {
      label: "gh api --input=@",
      command: "gh api repos/o/r/issues/1/comments --input=@dirty.md",
      dirty: true,
    },
    { label: "git commit -F separate", command: "git commit -F dirty.md", dirty: true },
    { label: "git commit -F glued", command: "git commit -Fdirty.md", dirty: true },
    { label: "git commit --file=", command: "git commit --file=dirty.md", dirty: true },
    { label: "git commit -aF glued", command: "git commit -aFdirty.md", dirty: true },
    { label: "git commit -F glued clean", command: "git commit -Fclean.md", dirty: false },
    { label: "git commit -amF glued clean", command: "git commit -amFclean.md", dirty: false },
  ];
  for (const f of fileForms) {
    // `dirty.json`/`clean.json` are the same bytes under the name the --input
    // forms use (their content is the request body, not markdown).
    if (f.command.includes("dirty.json"))
      writeFileSync(path.join(dir, "dirty.json"), `{"body":"${TERM}"}`);
    if (f.command.includes("-idrty.json"))
      writeFileSync(path.join(dir, "drty.json"), `{"body":"${TERM}"}`);
    const d = await ask(f.command);
    if (f.dirty) {
      assert(
        blocked(d) && d?.verdict.kind === "denylist",
        `${f.label}: a glued/delimited file flag is BLOCKED on the file's CONTENTS (got ${d?.verdict.kind})`,
      );
      const scan = scanPublishSurfaces(f.command, dir);
      assert(
        scan.texts.some((t) => t.text.includes(TERM)),
        `${f.label}: the scan read the file, not the path`,
      );
      assert(
        !scan.texts.some((t) => t.text.endsWith(".md")),
        `${f.label}: the PATH is not scanned as the published text`,
      );
    } else {
      assert(
        !blocked(d),
        `${f.label}: a clean file's contents are ALLOWED (got ${d?.reason?.slice(0, 60)})`,
      );
    }
  }
  // An unreadable glued file flag keeps its fail-closed refusal.
  const gone = await ask("gh pr comment 3 -Fno-such-file.md");
  assert(
    blocked(gone) && gone?.verdict.kind === "unreadable",
    `a glued -F pointing at nothing is REFUSED as unreadable (got ${gone?.verdict.kind})`,
  );
  const outside = await ask("gh pr comment 3 -F/etc/hostname");
  assert(
    blocked(outside) && outside?.verdict.kind === "unreadable",
    `a glued -F outside the admitted roots is REFUSED on its PATH (got ${outside?.verdict.kind})`,
  );

  // ──────────────────────────────────────────────────────────────────────
  // 5. THE FAIL-CLOSED INVARIANT (item 2): a recognised publish whose text the
  //    guard did not read is refused; a publish that names NO text surface is
  //    left alone, because the guard never had anything to read.
  // ──────────────────────────────────────────────────────────────────────
  const noSurface = await ask("git commit --amend --no-edit");
  assert(
    !blocked(noSurface),
    `git commit --amend --no-edit is ALLOWED (got ${noSurface?.reason?.slice(0, 50)})`,
  );
  assert(
    scanPublishSurfaces("git commit --amend --no-edit", dir).problems.length === 0,
    "a commit that names no message flag records no problem",
  );
  // A text flag the reader owns, present and producing nothing, IS refused.
  const silent = scanPublishSurfaces("gh pr comment 3 -b $(cat f)", dir);
  assert(
    silent.publishes && silent.texts.length === 0 && silent.problems.length > 0,
    "a publish whose body flag the reader could not finish is refused, not passed",
  );
  // A flag the tables do not know publishes nothing, so it is NOT refused — gh
  // would post an empty comment, and the guard has no text it failed to read.
  assert(
    scanPublishSurfaces("gh pr comment 3 --bogus-text x", dir).texts.length === 0,
    "an unknown flag reads no text (the control below pins that it is allowed unless the scan still claims a surface)",
  );

  // ──────────────────────────────────────────────────────────────────────
  // 6. THE DELETED QUOTE RULE (item 3): bash never runs a command whose quotes
  //    do not pair, and an apostrophe inside a PAIRED quote is ordinary prose.
  // ──────────────────────────────────────────────────────────────────────
  const apostrophe = await ask('gh pr comment 3 --body "don\'t do this"');
  assert(
    !blocked(apostrophe),
    `a body with an apostrophe is ALLOWED (got ${apostrophe?.reason?.slice(0, 60)})`,
  );
  assert(
    scanPublishSurfaces("gh pr comment 3 --body 'don't do this'", dir).texts.length === 1,
    "the same body is read as one text surface",
  );

  // ──────────────────────────────────────────────────────────────────────
  // 7. THE THIRD DRIVER COMMIT SITE (#1788 follow-up, item 4). The cherry-pick /
  //    patch path in `work-driver-integrate.ts` committed `commitTitle`/
  //    `commitBody` through an exec with no check — the fast-forward path had
  //    been gated and this one had not, so the same issue prose reached the
  //    branch by the other route. Pinned structurally: the site calls the same
  //    seam BEFORE its `git commit` exec.
  // ──────────────────────────────────────────────────────────────────────
  const integrateSrc = readFileSync(
    path.join(import.meta.dirname, "..", "src", "work-driver-integrate.ts"),
    "utf8",
  );
  const gateSrc = readFileSync(
    path.join(import.meta.dirname, "..", "src", "work-driver-commit-message-publish.ts"),
    "utf8",
  );
  const commitAt = integrateSrc.indexOf("git commit -m ${JSON.stringify(gate.title)}");
  const gateCallAt = integrateSrc.indexOf("cherryPickCommitGate(");
  assert(commitAt > 0, "the cherry-pick path still carries its own commit exec");
  assert(
    integrateSrc.indexOf("JSON.stringify(opts.commitTitle)") < 0,
    "the cherry-pick exec no longer commits the caller's RAW title: it commits the bytes " +
      "the gate judged (#1820 — a rewrite the commit site discards is a rewrite that never ships)",
  );
  assert(
    gateCallAt > 0 && gateCallAt < commitAt,
    "the cherry-pick commit site calls the gate before it execs git commit",
  );
  assert(
    gateSrc.includes("commitMessageForPublish(") &&
      /refusalResult:[\s\S]{0,160}?ok: false,[\s\S]{0,80}?failure: "apply"/.test(gateSrc),
    "the gate checks the message and returns a parked failure (ok:false/apply) rather than throwing",
  );
  assert(
    !/\bthrow\s+new\b/.test(gateSrc),
    "the gate returns a reason rather than throwing past integrate()'s contract",
  );
});

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
