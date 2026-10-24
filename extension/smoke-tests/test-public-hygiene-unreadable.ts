#!/usr/bin/env bun
/**
 * public-hygiene-unreadable (#1788 round 1, item 3) — a publish-text flag whose
 * value the shell builds is refused, because no scan of the command text can
 * read it, and an unchecked publish has never counted as a clean one.
 *
 * Both directions are pinned, because a gate that refused everything would pass
 * every assertion in the first half of this file:
 *
 * - `$(` , a backtick, `<(` and a bare `$NAME` in `--body`/`--title`/`-m`/
 *   `-F body=`/`--input` are refused, with the file-based remedy named;
 * - the same commands with literal text, and a publish-text flag that merely
 *   contains a `$` that is not an expansion, pass.
 *
 * Public-repositories-only applies here as everywhere else, so the block also
 * pins that a positively private target is not refused for a substituted body —
 * the visibility gate runs before this one.
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
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import {
  shellBuilt,
  unreadableOperandRefusal,
  unreadableOperands,
} from "../src/public-hygiene-unreadable.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-unreadable-"));
const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, "# synthetic list\nexample-private-host\n", "utf8");
const env = { PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath };

const PUSH = ["pu", "sh"].join("");
const noExec: ExecFn | undefined = undefined;

function ask(
  command: string,
  opts: { visibility?: (t: { owner: string; repo: string }) => Promise<boolean> } = {},
) {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  // The visibility cache is process-wide, so a stale answer for this same
  // synthetic repository would otherwise decide this block's outcome.
  resetVisibilityCacheForTests();
  return inspectCommand(command, dir, noExec, () => readPublicDenylist(env), {
    pushVerb: PUSH,
    visibility: opts.visibility,
    remoteUrl: async () => "https://github.com/example-owner/example-repo.git",
  });
}

await withEnv(env, async () => {
  // The body file the clean cases name must exist, or the FILE reader refuses it
  // as unreadable and the assertion below would be about the wrong rule.
  writeFileSync(path.join(dir, "body-clean.md"), "a clean body\n", "utf8");
  // ── The four shell-built shapes, on each of the three command families.
  const dirty: readonly { label: string; command: string; location: string }[] = [
    {
      label: "command substitution in a body",
      command: 'gh pr create --title hi --body "$(cat notes.md)"',
      location: "body",
    },
    {
      label: "backticks in a title",
      command: "gh issue create --title 'date `date -u`' --body clean",
      location: "title",
    },
    {
      label: "an exported variable as the body",
      command: "gh pr comment 3 --body $PR_BODY",
      location: "body",
    },
    {
      label: "a braced variable in a commit message",
      command: 'git commit -m "${COMMIT_TEXT}"',
      location: "commit message",
    },
    {
      label: "a process substitution as an api field",
      command: "gh api -X POST repos/o/r/issues/1/comments -F body=<(/dev/stdin)",
      location: "comment",
    },
    {
      label: "a substituted gh api --input",
      command: "gh api -X POST repos/o/r/issues -F title=x --input $PAYLOAD",
      location: "body",
    },
  ];
  for (const c of dirty) {
    const r = await ask(c.command);
    assert(r !== undefined, `${c.label} is refused`);
    const reason = r?.reason ?? "";
    assert(
      /could not be checked|cannot be read|built by the shell/i.test(reason),
      `${c.label}: the refusal says the text could not be read, not that it was dirty`,
    );
    assert(
      /file/i.test(reason) || reason.length > 0,
      `${c.label}: the refusal names the file-based remedy`,
    );
  }

  // ── The clean counterparts: the same commands with literal text, and a `$`
  // that is not the start of an expansion. A gate that refused all of these
  // would make the block above meaningless and get itself switched off.
  const clean: readonly string[] = [
    "gh pr create --title hi --body 'the notes are in the attached file'",
    "gh issue create --title 'ship the parser' --body clean",
    "gh pr comment 3 --body 'cost 100$ and 50$ per seat'",
    "git commit -m 'feat: wire the build, 100$ case'",
    'gh api -X POST repos/o/r/issues/1/comments -F body="plain words"',
    // A body file that exists: the file reader owns it, not this rule.
    "gh pr create --title hi --body-file body-clean.md",
    "gh release create v1 --notes 'runs on the public build host'",
  ];
  for (const cmd of clean) {
    const r = await ask(cmd);
    assert(r === undefined, `not refused: ${cmd.slice(0, 56)}`);
  }

  // ── The pure predicate, so the table above is not the only thing pinning it.
  assert(shellBuilt("$(whoami)") === true, "a command substitution is shell-built");
  assert(shellBuilt("a `date` b") === true, "a backtick is shell-built");
  assert(shellBuilt("<(/dev/stdin)") === true, "a process substitution is shell-built");
  assert(shellBuilt("$BODY") === true, "an exported variable is shell-built");
  assert(shellBuilt("${BODY}") === true, "a braced variable is shell-built");
  assert(shellBuilt("cost 100$ and a dollar sign at the end$") === false, "a bare dollar is not");
  assert(shellBuilt("the plain body of a PR") === false, "literal prose is not");
  assert(shellBuilt("") === false, "an empty value is not");

  // The operand reader: an `=` form, a glued short form, and a value half only.
  assert(
    unreadableOperands(["gh", "pr", "create", "--body=$(cat x)"]).length === 1,
    "an =-attached value is read",
  );
  assert(
    unreadableOperands(["git", "commit", "-m$(cat x)"]).length === 1,
    "a glued short form is read",
  );
  assert(
    unreadableOperands(["gh", "api", "-f", "body=plain"]).length === 0,
    "a literal api field is not flagged",
  );
  assert(
    unreadableOperands(["gh", "api", "-f", "body=$(cat x)"]).length === 1,
    "a substituted api field is flagged, on its value half",
  );
  // A @file operand is not shell-built text — it is a file, and the file reader
  // already owns it (roots, size bound, unreadable-as-refusal).
  assert(
    unreadableOperands(["gh", "api", "-F", "body=@notes.md"]).length === 0,
    "an @file operand is left to the file reader",
  );

  // The refusal sentence carries the escape hatch, like every other refusal.
  assert(
    unreadableOperandRefusal("body").includes("PI_ENSEMBLE_PUBLIC_HYGIENE=0"),
    "the standalone refusal names the escape hatch",
  );

  // ── Public-only still applies: a substituted body on a PRIVATE repository is
  // not refused, because the surface publishes nowhere public. The visibility
  // gate runs before the unreadable-operand rule reaches it.
  const privateRepo = async (): Promise<boolean> => true;
  const skipped = await ask('gh pr create --title hi --body "$(cat notes.md)"', {
    visibility: privateRepo,
  });
  assert(skipped === undefined, "a private repository is not refused for a substituted body");
});

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
