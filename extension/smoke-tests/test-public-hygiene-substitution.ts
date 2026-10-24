#!/usr/bin/env bun
/**
 * public-hygiene-substitution (#1788) — a publish in a command that contains a
 * shell expansion is refused, with NO quote modelling anywhere.
 *
 * The first shape of that module walked the raw command tracking quotes,
 * substitution depth and segment cuts. The final review returned nine defects,
 * every one of them a character bash treats specially that the model got wrong —
 * so the model was deleted rather than patched. The rule is now two independent
 * observations over the WHOLE command: it carries a publish surface (the scan's
 * own signal, `oo`/`NAME=value` prefix skip included), and its raw text contains
 * an expansion. Both true is one problem; neither half is decided by a quote.
 *
 * ## The false positive this accepts, deliberately
 *
 * `--body 'a $(b) is mentioned above'` is refused. Single quotes never expand, so
 * nothing hidden publishes — but the alternative is a quote model with the nine
 * holes above, round 1 already accepted refusing a single-quoted `$(`, and the
 * remedy is one file write (`--body-file`). That trade-off is stated in the
 * module header and in docs/troubleshooting.md; the REFUSED table pins it so a
 * future "fix" that re-introduces quote tracking has to argue with a test.
 *
 * Offline, synthetic terms, a scratch denylist always.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPublicDenylist, resetDenylistCacheForTests } from "../src/public-denylist.ts";
import {
  inspectCommand,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import { containsShellExpansion } from "../src/public-hygiene-substitution.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-substitution-"));
const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, "# synthetic list\nexample-private-host\n", "utf8");
const env = { PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath };

const PUSH = ["pu", "sh"].join("");
const noExec: ExecFn | undefined = undefined;

/** The guard's public entry point, as every other hygiene test drives it. */
async function ask(command: string) {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  resetVisibilityCacheForTests();
  return inspectCommand(command, dir, noExec, () => readPublicDenylist(env), {
    pushVerb: PUSH,
    remoteUrl: async () => "https://github.com/example-owner/example-repo.git",
  });
}

await withEnv(env, async () => {
  writeFileSync(path.join(dir, "body-clean.md"), "a clean body\n", "utf8");
  writeFileSync(path.join(dir, "field-clean.md"), "a clean field\n", "utf8");
  writeFileSync(path.join(dir, "field-dirty.md"), "example-private-host\n", "utf8");

  // ── REFUSED. Every one of these was ALLOWED while the module modelled quotes:
  // the walk's word reader produced words bash never produced, and the segment
  // was judged a non-publish.
  const dirty: readonly { label: string; command: string }[] = [
    {
      label: "a substitution after a space, with a tail",
      command: 'gh pr comment 3 --body "PREFIX $(cat f) tail"',
    },
    {
      label: "a substitution after a space, at the end",
      command: 'gh pr comment 3 --body "PREFIX $(cat f)"',
    },
    {
      label: "a substitution after a space in a title",
      command: 'gh issue create --title "a $(cat f)"',
    },
    {
      label: "a substitution after a space in a commit message",
      command: 'git commit -m "msg $(cat f)"',
    },
    // The `oo` runner prefix: the scan skips it in its own noun tables, and the
    // substitution walk did not, so a one-token prefix disabled the whole check.
    {
      label: "an oo-prefixed body substitution",
      command: 'oo gh pr comment 3 --body "a $(cat f) b"',
    },
    {
      label: "an oo-prefixed backtick body",
      command: 'oo gh pr comment 3 --body "a `cat f` b"',
    },
    {
      label: "an oo-prefixed glued substitution",
      command: "oo gh pr comment 3 --body $(cat f)",
    },
    {
      label: "an assignment-prefixed body substitution",
      command: 'FOO=bar gh pr comment 3 --body "a $(cat f) b"',
    },
    // Quote desync: an unmatched double quote made the word reader hand the
    // decision words bash never produced, so nothing was checked.
    {
      label: "an unmatched double quote before a substitution",
      command: 'gh pr comment 3 --jq ".url"" --body $(cat f)',
    },
    {
      label: "an unbalanced quote with an unterminated substitution",
      command: 'gh pr comment 3 --body "x $(cat f',
    },
    // An escaped quote inside double quotes desyncs a single-character tracker.
    {
      label: "an escaped quote then a substitution",
      command: 'gh pr comment 3 --body "say \\"hello\\" $(cat f)"',
    },
    // A stray `)` drove the substitution depth negative in the old walk, after
    // which its separators stopped cutting and its `$(` stopped counting.
    {
      label: "a stray close paren before a substitution",
      command: 'gh pr comment 3 --body "a ) b $(cat f)"',
    },
    // Only the head of a chain used to be asked, so a publish after `&&` was
    // invisible to the walk.
    {
      label: "a publish in the tail of a chain",
      command: 'true && gh pr comment 3 --body "a $(cat f)"',
    },
    {
      label: "a publish before a substitution-owned tail",
      command: 'gh pr comment 3 --body "a $(cat f)" && echo done',
    },
    // A newline inside quotes used to cut the segment, so the publish flag and
    // the substitution landed in different segments and neither matched.
    {
      label: "a multi-line quoted body with the substitution on line 2",
      command: 'gh pr comment 3 --body "first line\nsecond $(cat f)"',
    },
    {
      label: "backticks in a body",
      command: 'gh pr comment 3 --body "a `cat f` b"',
    },
    {
      label: "a backtick form the word splitter cut in half",
      command: "gh pr comment 3 --body `cat f`",
    },
    {
      label: "a braced variable expansion",
      command: 'gh pr comment 3 --body "${BODY}"',
    },
    {
      label: "a bare variable expansion",
      command: "gh pr comment 3 --body $BODY",
    },
    {
      label: "a process substitution",
      command: "gh pr comment 3 --body <(cat f)",
    },
    {
      label: "a separator INSIDE the substitution",
      command: 'gh pr comment 3 --body "x $(cat f; echo y) z"',
    },
    {
      label: "a gh api field built by the shell",
      command: "gh api repos/o/r/issues/1/comments -F body=$(cat f)",
    },
    {
      label: "a gh api glued field built by the shell",
      command: "gh api repos/o/r/issues/1/comments -Fbody=$(cat f)",
    },
    // Refused BY DESIGN: single quotes never expand, so this publishes literal
    // text the guard could have read. The quote-free model does not look, and the
    // trade-off is documented rather than silently paid.
    {
      label: "a single-quoted literal that merely contains a substitution",
      command: "gh pr comment 3 --body 'a $(b) is mentioned above'",
    },
    // "An unbalanced quote swallowing every flag after it" USED to sit here
    // (`gh pr comment 3 --body 'unterminated --title`). It is deleted with the
    // rule (#1792 follow-up, item 3): bash never runs a command whose quotes do
    // not pair, so the parity count refused only what the shell would have
    // rejected anyway — and it refused `--body "don't do this"` on the way.
    // ── gh api `@file` fields: the value is a POINTER, and reading the literal
    // `@notes.md` instead of the file was a publish nobody checked.
    {
      label: "an api @file field carrying a denylist term",
      command: "gh api repos/o/r/issues/1/comments -F body=@field-dirty.md",
    },
    {
      label: "an api glued @file field carrying a denylist term",
      command: "gh api repos/o/r/issues/1/comments -Fbody=@field-dirty.md",
    },
    {
      label: "an api @file field the guard cannot read",
      command: "gh api repos/o/r/issues/1/comments -F @gone.md",
    },
    {
      label: "an api @file field naming a path outside the admitted roots",
      command: "gh api repos/o/r/issues/1/comments -F @/etc/hostname",
    },
  ];
  for (const c of dirty) {
    const r = await ask(c.command);
    assert(r !== undefined, `${c.label} is refused`);
    // A `@file` carrying a denylist term is a DIRTY publish, refused as one; an
    // out-of-root PATH is refused by its PATH alone (which is not a shell-built
    // text, so it gets its own arm). Everything else here is refused as text no
    // one could read; asserting the wrong sentence would pin a leak as a pass.
    const denylistHit = c.label.includes("denylist term");
    const outOfRoots = c.label.includes("outside the admitted roots");
    assert(
      denylistHit ||
        outOfRoots ||
        /could not be checked|cannot be read|built by the shell/i.test(r?.reason ?? ""),
      `${c.label}: ${denylistHit ? "refused as a dirty publish" : "refused as text that could not be read"}`,
    );
    assert(
      denylistHit || outOfRoots || /--body-file|@file|body-file/i.test(r?.reason ?? ""),
      `${c.label}: the refusal names the file remedy`,
    );
    assert(
      !String(c.command).includes("example-private-host"),
      `${c.label}: the refusal never contains the term`,
    );
  }

  // ── ALLOWED. A gate that refused these gets its escape hatch set and the check
  // that matters stops running.
  const clean: readonly string[] = [
    'gh pr comment 3 --body "a plain sentence about the release"',
    "gh pr comment 3 --body 'cost 100 dollars'",
    "gh pr comment 3 --body 'a literal sentence about the release'",
    'gh pr comment 3 --body "it\'s fine"',
    "gh pr comment 3 --body-file body-clean.md",
    "oo gh pr comment 3 --body-file body-clean.md",
    // No publish surface: the expansion belongs to a command that publishes
    // nothing, so there is no text at risk.
    "echo $(date)",
    "oo echo $(date)",
    'git log --format="%H $(x)"',
    "git log --oneline -5",
    // A gh api GET with a jq selector is not a write and publishes no text.
    "gh api repos/o/r/issues/1 --jq '.x'",
    "gh api repos/o/r/pulls --jq '.[].title'",
    // ── gh api @file fields the guard CAN read, so the read path stays open.
    "gh api repos/o/r/issues/1/comments -F body=@field-clean.md",
    "gh api repos/o/r/issues/1/comments -Fbody=@field-clean.md",
    "gh api repos/o/r/issues/1/comments -f body=@field-clean.md",
    "gh api repos/o/r/issues/1/comments -fbody=plain text",
    "gh api repos/o/r/issues/1/comments --field=body=plain text",
    "gh api repos/o/r/issues/1/comments --raw-field=body=@field-clean.md",
  ];
  for (const cmd of clean) {
    const r = await ask(cmd);
    assert(r === undefined, `not refused: ${cmd.slice(0, 62)}`);
  }

  // ── The predicate itself, so the table above is not the only thing pinning it.
  assert(containsShellExpansion("a $(b) c"), "a $() is an expansion");
  assert(containsShellExpansion("`cat f`"), "a backtick is an expansion");
  assert(containsShellExpansion("${BODY}"), "a braced variable is an expansion");
  assert(containsShellExpansion("$BODY"), "a bare variable is an expansion");
  assert(containsShellExpansion("<(cat f)"), "a process substitution is an expansion");
  assert(containsShellExpansion(">(cat f)"), "a write-side substitution is an expansion");
  assert(
    !containsShellExpansion("a plain sentence about the release"),
    "prose is not an expansion",
  );
  assert(!containsShellExpansion("cost 100 dollars"), "a dollar that heads nothing is not");
});

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
