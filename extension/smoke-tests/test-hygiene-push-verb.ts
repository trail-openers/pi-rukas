/**
 * test-hygiene-push-verb.ts — the verb POSITION of a push, read through the one
 * git-global walker (#2168).
 *
 * `commandPushes` is a union of two predicates and this file pins the added half:
 * the word reader. The regex half has its own table in
 * `test-developer-push-guard.ts`, and the union is what the guard uses, so both
 * are needed and neither file substitutes for the other.
 *
 * What the word reader exists for is the shape the regex cannot reach: git's
 * globals sit between the program and the verb, and the ones that take their value
 * as a SEPARATE word move the verb one place further along. A reader that walked
 * flags naively would read `--git-dir`'s own operand as the verb, and a reader
 * that skipped nothing would miss the verb entirely. Each case below is one of
 * those two mistakes, in the direction that matters: a push that is NOT seen is a
 * silent no-op, and a non-push that IS seen is a false refusal of a harmless
 * command.
 */

import { commandCarriesPushVerb } from "../src/git-push-words.ts";
import { commandPushes } from "../src/public-hygiene-scan.ts";
import { PUSH_VERB } from "../src/public-hygiene-verbs.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const P = PUSH_VERB;

// ── the verb git itself would see ────────────────────────────────────────────
const pushCases: [string, string][] = [
  [`git ${P} origin main`, "the bare form"],
  [`git -C /w/wt ${P} -u origin b`, "a -C before the verb"],
  [`git -c user.name=t -C /w/wt ${P} origin b`, "a -C behind a -c that consumes a word"],
  [`env FOO=1 git -C /w/wt ${P} origin b`, "an env wrapper before git"],
  [`FOO=1 git -C /w/wt ${P} origin b`, "an assignment before git"],
  [`git --git-dir /w/.git --work-tree /w ${P} origin b`, "the refused globals, bare spelling"],
  [`git --git-dir=/w/.git --work-tree=/w ${P} origin b`, "the refused globals, attached spelling"],
  [`git ${P} --force-with-lease origin b`, "options after the verb"],
  // The verb position is UNKNOWABLE past a refused global: after `--git-dir X`
  // the walker cannot tell whether git read `X` as the flag's VALUE (so `push` is
  // the verb, and this is a push) or as the VERB (so `push` is a mere operand).
  // The conservative reading is the one that never lets a push go unscanned, so
  // the reader answers true — and the command is refused on the refused flag
  // either way, which is what makes the over-read cheap here and would not be
  // cheap for any other command shape. Pinned as a push so the choice is visible
  // rather than remembered.
  [
    `git --git-dir /w/.git --work-tree /w echo ${P}`,
    "a refused global makes the verb position unknowable",
  ],
  // The payload forms, which is where a reader that hand-walked the segments
  // instead of asking the segmenter lost the push altogether: `env -S '…'` hands
  // back `{ argv: [], split: [payload] }`, so the per-segment stripper answers NO
  // WORDS and the verb inside the payload is never asked about — while the
  // directory reader, walking the segmenter, resolved that payload's `-C` and
  // pointed the scan at the worktree. One reader seeing the push and the other
  // not is how a real push reaches a github.com remote unscanned, so the two
  // readers are pinned to the SAME segmenter by pinning this form here.
  [`env -S 'git ${P} origin b'`, "an `env -S` payload that is itself a command line"],
  [
    `env -S 'git -C /w/wt ${P} origin b'`,
    "an `env -S` payload that carries the -C (the wrapper-hides-the-directory family)",
  ],
  [
    `true; env -S 'git ${P} origin b'`,
    "an `env -S` payload behind a chain prefix that supplies the publish word the backstop needs",
  ],
  [
    `git status && env -S 'git ${P} origin b'`,
    "an `env -S` payload as the second segment of a chain",
  ],
  // A program the wrapper table does not know is NOT stripped (that is what the
  // table means), so `busybox git push` has the table as its boundary and the
  // regex half — scan-not-anchor over the raw text — is what catches it. What the
  // word reader must never do is strip a word it was not told to strip: a reader
  // that skipped any non-git program looking for git would read the words after
  // `push` as git's own and make a hundred harmless commands into pushes. Pinned
  // both halves: the word reader says no, the union still says yes.
];
for (const [command, why] of pushCases) {
  assert(commandCarriesPushVerb(command, P) === true, `${why} is a push`);
  assert(commandPushes(command) === true, `…and the union agrees: ${why}`);
}

// ── the word `push` is not the verb ─────────────────────────────────────────
const notPushCases: [string, string][] = [
  [`git status`, "a status"],
  [`git log --oneline`, "a log"],
  [`echo ${P} origin main`, "an echo of the word"],
  [`git commit -m "fix the ${P} script"`, "the word inside a commit message"],
  [`git ${P}origin main`, "a glued verb is not git's verb"],
  [`git checkout ${P}`, "the verb as an operand of another verb"],
  [`git config remote.${P}.url https://x/y`, "the word inside a key"],
  // A command with a refused global and NO verb is still not a push: the refusal
  // for a refused global is issued for a command that publishes something, and
  // `git --git-dir X status` publishes nothing.
  [`git --git-dir /w/.git --work-tree /w status`, "refused globals and no verb at all"],
];
for (const [command, why] of notPushCases) {
  assert(commandCarriesPushVerb(command, P) === false, `${why} is not a push`);
}

// ── a path that ENDS in the verb is git's, not the command's ────────────────
// The mistake this pins is the one `commitMessageReuse` was written for: locating
// the verb by searching the words finds a path that happens to end in it.
assert(
  commandCarriesPushVerb(`git -C /srv/my${P} commit -m x`, P) === false,
  "a -C operand whose path ends in the verb does not make a push",
);

// ── past a chain / wrapper the segmenter already handles ────────────────────
assert(
  commandCarriesPushVerb(`cd /w/wt && git ${P} origin main`, P) === true,
  "the push segment of a chain is seen",
);

// The backstop's blind spot, stated plainly. `looksLikePublish` fires on a
// `git commit -m` / `gh … --body` shape only — there is no push shape in it — so
// a bare `env -S 'git push …'` has no publish word in the raw text and the
// backstop is silent about it. The ONLY thing standing between that command and
// an unscanned publish is the word reader, which is why the payload cases above
// are pinned as pushes rather than left to the backstop.
assert(
  commandPushes(`env -S 'git ${P} origin main'`) === true,
  "the union alone catches a push whose only spelling is an `env -S` payload",
);

// The wrapper table's boundary, in the over-refusal direction. `busybox` is not
// in WRAPPERS, so the segmenter leaves it as the program word and the word
// reader — which asks its question of the PROGRAM word — says no. The regex half
// catches it, so the union sees the push; what is pinned here is that the word
// reader did not reach it by stripping a word it was not told to strip, which is
// how `git <program> push` would otherwise become a push for any <program>.
assert(
  commandCarriesPushVerb(`busybox git ${P} origin b`, P) === false,
  "a git behind a program outside the wrapper table is not read as a push BY THE WORD READER",
);
assert(
  commandPushes(`busybox git ${P} origin b`) === true,
  "…and the union still sees it, through the regex half",
);

process.exit(exit);
