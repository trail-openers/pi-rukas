#!/usr/bin/env bun
/**
 * public-hygiene-substitution (#1788 round 2) — the walk that sees what the
 * word splitter cannot.
 *
 * `simpleCommands` ENDS a command at `$(`, so a publish-text operand whose
 * substitution sits AFTER a space — `gh pr comment 3 --body "PREFIX $(cat f)
 * tail"` — reached the decision as the single clean word `PREFIX`, while bash
 * published the file's contents. A substitution glued to the flag was already
 * refused; one behind a space was the hole. This file pins both directions at
 * the guard's public entry point, plus the segment splitter on its own.
 *
 * The literal-text cases deliberately use NO `$` at all. `--body 'a $(cat f) b'`
 * is a genuine non-leak (single quotes never expand, so what publishes is the
 * literal text the guard can read), but the round-1 rule already refuses every
 * operand whose WORDS contain `$(`, quoted or not — `test-public-hygiene-
 * unreadable.ts` pins that as intended behaviour. This module widens nothing
 * beyond the hole it closes, so it stays silent where round 1 already speaks,
 * and a `$`-free literal is the case that pins the single-quote half of the walk.
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
import { publishSegmentsWithSubstitution } from "../src/public-hygiene-substitution.ts";
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

  // ── REFUSED. Each of these was ALLOWED before the raw text was walked: the
  // word splitter cut the operand at the `$(`, so only the text before the
  // substitution reached the decision and was judged clean.
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
    {
      label: "a substitution after a space in an api field",
      command: 'gh api repos/o/r/issues/1/comments -F body="x $(cat f)"',
    },
    {
      label: "backticks in a body",
      command: "gh pr comment 3 --body \"a `cat f` b\"",
    },
    {
      label: "a separator INSIDE the substitution",
      command: 'gh pr comment 3 --body "x $(cat f; echo y) z"',
    },
    {
      label: "an unbalanced quote with an unterminated substitution",
      command: 'gh pr comment 3 --body "x $(cat f',
    },
    // Round 1 already refused these two shapes through the word list; they stay
    // refused here so the new walk is never the only thing standing between the
    // command and the publish.
    {
      label: "an unbalanced single quote, whose flag the walker still finds",
      command: "gh pr comment 3 --body 'unterminated",
    },
  ];
  for (const c of dirty) {
    const r = await ask(c.command);
    assert(r !== undefined, `${c.label} is refused`);
    assert(
      /could not be checked|cannot be read|built by the shell/i.test(r?.reason ?? ""),
      `${c.label}: the refusal says the text could not be read, not that it was dirty`,
    );
  }

  // ── ALLOWED. A gate that refused these gets its escape hatch set and the
  // check that matters stops running.
  const clean: readonly string[] = [
    // Single quotes are literal, and there is no expansion in them at all: the
    // guard reads this text, so a `$`-free literal body publishes nothing hidden.
    "gh pr comment 3 --body 'a literal sentence about the release'",
    "gh pr comment 3 --body 'cost 100 and 50 per seat'",
    // Plain prose, and prose with an apostrophe inside double quotes.
    'gh pr comment 3 --body "a plain sentence about the release"',
    'gh pr comment 3 --body "it\'s fine"',
    // A substitution owned by ANOTHER command in the chain says nothing here.
    "gh pr comment 3 --body-file body-clean.md && echo $(date)",
    "echo $(date)",
    // Not a publish: git log's format string is not text the forge publishes.
    'git log --format="%H $(x)"',
  ];
  for (const cmd of clean) {
    const r = await ask(cmd);
    assert(r === undefined, `not refused: ${cmd.slice(0, 62)}`);
  }

  // ── The splitter itself, so the table above is not the only thing pinning it.
  const segs = (raw: string) => publishSegmentsWithSubstitution(raw);
  assert(
    segs('gh pr comment 3 --body "PREFIX $(cat f) tail"').length === 1,
    "one publishing segment is returned for a substituted body",
  );
  assert(
    segs('gh pr comment 3 --body "a b" && git commit -m "x $(y)"').length === 1,
    "only the segment that publishes and substitutes is returned",
  );
  assert(
    segs('gh pr comment 3 --body "x $(cat f; echo y) z"').length === 1,
    "a separator inside a substitution does not split the segment",
  );
  assert(
    segs("gh pr comment 3 --body 'a literal sentence'").length === 0,
    "a single-quoted segment with no expansion is not a substitution",
  );
  assert(
    segs('echo hi; gh pr edit 3 --title "t $(x)" | cat').length === 1,
    "segments are cut at unquoted ; and | outside a substitution",
  );
  assert(
    segs('gh pr comment 3 --body "a b $(f)"').length === 1,
    "a double-quoted operand with a live substitution is one segment",
  );
  assert(
    segs("gh pr comment 3 --body 'unterminated").length === 1,
    "an unbalanced quote fails closed on a publishing segment",
  );
  assert(
    segs("gh pr comment 3 --body 'a literal word'").length === 0,
    "an unbalanced quote with nothing substitutable stays clean",
  );
  assert(
    segs("echo $(date)").length === 0 && segs("git log --format=\"%H $(x)\"").length === 0,
    "a non-publishing command returns no segment",
  );
});

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
