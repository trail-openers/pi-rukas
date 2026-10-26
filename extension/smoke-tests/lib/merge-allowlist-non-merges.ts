/**
 * The merge-allowlist fixture tables, part 2: the commands the guard must NOT
 * hold.
 *
 * Split from `merge-allowlist-fixtures.ts` along the one seam that matters: the
 * tables there are the merges the guard must HOLD, and these are the commands
 * it must leave alone. They answer opposite questions and a row can only be
 * correct for one of them, so they are not two halves of one list.
 *
 * `NOT_MERGES` is the false-positive table — a command that mentions a merge
 * word only in prose, or is a read, or is another tool entirely, must classify
 * as `none`. The over-refusal that would make the guard unusable is the failure
 * this half pins, which is why it lives apart from the refusals: a fixture that
 * grew one list would eventually satisfy itself by holding more.
 *
 * `RESIDUAL` is the documented out-of-scope set (#962): shapes that spell no
 * merge word at all, listed so the gap is named rather than assumed absent. See
 * "The documented residual" in docs/troubleshooting.md, of which this table is
 * the executable counterpart.
 *
 * `GLAB_NO_OPT_OUT` is the one class of refusal that lives here rather than in
 * part 1 because it is refused for a reason the classifier does not share: a
 * `glab mr merge` without the `--auto-merge=false` opt-out, refused by name.
 */

/** Commands that are not merges at all: the reader must answer `none`. */
export const NOT_MERGES: string[] = [
  "gh pr view 17 --json mergeable,mergeStateStatus",
  "gh pr list --state merged",
  "gh pr checks 17",
  "git merge --ff-only origin/main",
  'git commit -m "fix: x"',
  "rg merge src/",
  "echo merge",
  "gh pr comment 5 --body-file x.md",
  "gh pr view 17; gh pr checks 17 && echo done",
  "gh api repos/o/r/pulls/17 --jq .mergeable",
  "cd x && git merge origin/main",
  "gh pr view 17 --json mergeable,mergeStateStatus,mergedAt,mergeCommit",
  "gh api graphql -f query='{ viewer { login } }'",
  "glab api graphql -f query='{ currentUser { username } }'",
  "gh pr view 17 $'x'",
  "gh pr ready 17",
  "gh pr review 17 --approve",
  "gh issue create --title merge-bot --body-file x.md",
  // #1417 — the create exemption narrowed to what is provably inert: a bare
  // creation, or a creation whose prose lives in a FILE the guard cannot read
  // (the guard's own documented remedy for a merge word in prose, and the
  // shape forge-commands.ts posts with). A title is prose and stays exempt.
  "gh pr create --title merge-the-branch",
  "gh pr create --title x --head b --body-file b.md",
  'gh pr create --title "refuse merge shapes" --body-file x.md',
  "gh issue create --title 'merge the thing' --body-file b.md",
  "gh pr create --title x",
  "",
];

/**
 * The residual (#962): a merge assembled entirely from expansions spells no
 * merge word, so the reader answers `none` for it. Out of scope under the
 * honest-but-forgetful threat model — see "The documented residual" in
 * docs/troubleshooting.md, which this table is the executable counterpart of.
 */
export const RESIDUAL: string[] = [
  "gh pr m$X 17",
  "$G pr m$X 17",
  "gh pr m$(echo e)rge 17",
  "gh pr m?rge 17",
  "bash x.sh",
];

/** glab merges missing the `--auto-merge=false` opt-out: refused by name. */
export const GLAB_NO_OPT_OUT: string[] = [
  "glab mr merge 12",
  "glab -R g/p mr merge 3 --squash",
  "glab mr merge 12 -m --auto-merge=false",
];
