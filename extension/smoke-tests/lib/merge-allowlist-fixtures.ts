/**
 * merge-allowlist-fixtures — the decision-matrix data the allowlist suite
 * asserts over (#962, split out for the AGENTS.md §12 size cap).
 *
 * The suite is three tables of command strings plus the assertions over them.
 * The tables are data with no behaviour, so they live here and the test files
 * keep the `assert` loops — the split is at the natural seam rather than in the
 * middle of one. Each row is the exact command text a bypass attempt in the
 * #955/#1317 reviews used, so a row is load-bearing prose, not a fixture to be
 * tidied: reword one and the shape it pins stops being covered.
 */

/**
 * A long forge-naming command past the bound, built here so the row above and
 * the tests read the same fixture. `--subject` keeps the words inside the
 * accepted grammar, so without the bound this command would be read as a
 * plain merge of #17 — the exact shape #955 refused to resolve.
 */
export function longMergeCommand(): string {
  return `gh pr merge 17 --subject ${"x".repeat(8100)}`;
}

/** `[command, forge, prNumber, repo]` — every form the reader accepts. */
export type AcceptedRow = [string, "github" | "gitlab", number | undefined, string | undefined];

export const ACCEPTED: AcceptedRow[] = [
  ["gh pr merge 17", "github", 17, undefined],
  ["gh pr merge", "github", undefined, undefined],
  ["gh pr merge --squash", "github", undefined, undefined],
  ["gh pr merge 17 --squash --delete-branch", "github", 17, undefined],
  ["gh pr merge 17 -s -d", "github", 17, undefined],
  ["gh pr merge 17 -m", "github", 17, undefined],
  ["gh pr merge 17 --merge --rebase -r", "github", 17, undefined],
  ["gh pr merge 17 --delete-branch=false", "github", 17, undefined],
  ["gh pr merge 17 --delete-branch=true --disable-auto", "github", 17, undefined],
  ['gh pr merge 17 --subject "fix: a b" --body-file x.md', "github", 17, undefined],
  ["gh pr merge 17 --subject 'fix(review): x; y' -b 'z'", "github", 17, undefined],
  ["gh pr merge 17 -t subj -F body.md -A me@example.com", "github", 17, undefined],
  [
    "gh pr merge 17 --subject=x --author-email=a@b.c --match-head-commit abc123",
    "github",
    17,
    undefined,
  ],
  ["gh pr merge 17 --match-head-commit=abc123", "github", 17, undefined],
  ["gh pr merge 17 --subject 17", "github", 17, undefined],
  ["gh -R o/r pr merge 17", "github", 17, "o/r"],
  ["gh --repo o/r pr merge 17 --squash", "github", 17, "o/r"],
  ["gh --repo=o/r pr merge 17", "github", 17, "o/r"],
  ["gh pr merge 17 -R o/r", "github", 17, "o/r"],
  ["gh pr merge 17 --squash --repo=my.org/my-repo_1", "github", 17, "my.org/my-repo_1"],
  ["gh pr merge -R o/r", "github", undefined, "o/r"],
  ['gh pr "merge" 17', "github", 17, undefined],
  ["gh pr merge '17'", "github", 17, undefined],
  // Quote removal is bash's: these run `gh pr merge 17` and are read so.
  ['gh p"r" m"erge" 17', "github", 17, undefined],
  ["gh pr m'erge' 17", "github", 17, undefined],
  ['gh pr me""rge 1"7"', "github", 17, undefined],
  ["  gh\tpr  merge   17  ", "github", 17, undefined],
  // glab merges only with --auto-merge=false (a bare merge is refused below).
  ["glab mr merge 12 --auto-merge=false", "gitlab", 12, undefined],
  ["glab mr merge --auto-merge=false", "gitlab", undefined, undefined],
  ["glab mr merge 12 --squash -d --rebase -y --auto-merge=false", "gitlab", 12, undefined],
  [
    "glab mr merge 12 -s --remove-source-branch -r --yes --auto-merge=false",
    "gitlab",
    12,
    undefined,
  ],
  [
    'glab mr merge 12 -m "msg here" --squash-message s --sha abc --auto-merge=false',
    "gitlab",
    12,
    undefined,
  ],
  ["glab mr merge -m 17 --auto-merge=false", "gitlab", undefined, undefined],
  ["glab mr merge 12 --message=x --sha=abc --auto-merge=false", "gitlab", 12, undefined],
  ["glab -R group/sub/proj mr merge 12 --auto-merge=false", "gitlab", 12, "group/sub/proj"],
  ["glab --repo g/p mr merge 3 --auto-merge=false", "gitlab", 3, "g/p"],
  ["glab mr merge 3 -R a/b --auto-merge=false", "gitlab", 3, "a/b"],
];

/**
 * Commands the reader must never accept as a merge: the bypass shapes the
 * #955/#1317 reviews produced (GraphQL by name, expansion-named forges,
 * interpreters, indirect bodies) plus every shell shape that could defer or
 * hide the call.
 */
export const REFUSED: string[] = [
  // #962 review: GraphQL merges by name (GitHub and GitLab), expansion-named
  // forges, interpreters, GraphQL queries read from a file.
  'glab api graphql -f query=\'mutation { mergeRequestAccept(input: {projectPath: "g/p", iid: "12"}) { mergeRequest { state } } }\'',
  "glab api graphql -f query='mutation { acceptMergeRequest(input: {}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }'",
  "$G api repos/o/r/pulls/17/merge -X PUT",
  '"$GH" pr merge 17',
  'g"h" pr merge 17',
  "node -e \"require('@octokit/rest'); x.pulls.merge({pull_number:17})\"",
  "python3 scripts/merge.py",
  "bun run smoke-tests/test-merge-guard.ts",
  "gh api graphql -F query=@q.graphql",
  "gh api graphql --input q.json",
  "gh api graphql -f query=$Q",
  "curl -d @body.json https://api.github.com/graphql",
  'gh pr merge 17 --subject "feat!: x"',
  "gh pr merge 17 --body-file ~/x.md",
  // Chains, pipes, newlines, background, redirections.
  "cd x && gh pr merge 17",
  "cd /data/3 && gh pr merge",
  "git status; gh pr merge 12 --squash",
  "gh pr merge 17 && gh pr merge 5",
  "gh pr merge 17 & gh pr merge 5",
  "gh pr merge 17 &gh pr merge 5",
  "echo hi\ngh pr merge 17",
  "gh pr merge 17\nglab mr merge 5",
  "gh pr merge 17\r",
  "gh pr merge 17 >/dev/null",
  "gh pr merge 17>/dev/null",
  "gh pr merge &>/dev/null 17",
  "gh pr merge &>>/dev/null 17",
  'gh pr merge 17 --subject "fix: a b" 2>&1 &',
  "nohup gh pr merge 17 &",
  "gh pr merge 17 # it's",
  "echo hi # gh pr merge 17",
  "gh pr merge 17 | cat",
  // Substitutions, nested and glued.
  "$(echo x)gh pr merge 9",
  "$(true) gh pr merge 12",
  "`true`gh pr merge 4",
  "x=$(gh pr merge 17)",
  "x=`gh pr merge 12`",
  'echo "$(gh pr merge 17)"',
  'gh pr merge 17 "$(gh pr merge 5)"',
  "gh pr merge 17 $(gh pr merge 5)",
  "gh pr merge 17 `gh pr merge 5`",
  'gh pr view "$(gh pr merge 5)"',
  "x=$(y=$(gh api repos/o/r/pulls/17/merge))",
  "cat <(gh pr merge 5)",
  "gh pr view 1 >(gh pr merge 5)",
  'gh pr merge 17 --subject "$(date)"',
  "gh pr merge $PR",
  'gh pr merge "$N"',
  "gh pr merge 1 $X",
  // Subshells, groups, control flow, functions, heredocs.
  "(gh pr merge 17)",
  "{ gh pr merge 12; }",
  "if true; then gh pr merge 12; fi",
  "for i in 1; do gh pr merge 12; done",
  "case x in 1) gh pr merge 17;; esac",
  "function f { gh pr merge 12; }; f",
  "sh <<EOF\ngh pr merge 12\nEOF",
  "cat <<'EOF'\ndon't\nEOF\ngh pr merge 17",
  'bash <<< "gh pr merge 12"',
  // Interpreters, eval, xargs, sourcing, alias.
  "echo gh pr merge 12 | sh",
  'echo "gh pr merge 12" | sh',
  "printf 'gh pr merge 12' | bash",
  "echo 17 | xargs -I{} gh pr merge {}",
  "echo 17 | xargs gh pr merge",
  "echo gh pr merge 12 > x.sh; sh x.sh",
  "source <(echo gh pr merge 12)",
  'bash -c "gh pr merge 17"',
  "bash -c 'gh pr merge 12 --squash'",
  "bash -c gh pr merge 17",
  "bash -c gh\\ pr\\ merge\\ 17",
  "bash -c gh' pr merge 17'",
  "sh -c 'glab mr merge 7'",
  'eval "gh pr merge 17"',
  "eval gh pr merge 17",
  'eval $"gh pr merge 17"',
  "alias m='gh pr merge'; m 17",
  // Wrappers and prefixes.
  "env gh pr merge 17",
  "env FOO=1 gh pr merge 12",
  "FOO=1 gh pr merge 12",
  "GH_REPO=a/b gh pr merge 12",
  "command gh pr merge 17",
  "builtin gh pr merge 17",
  "nice gh pr merge 12",
  "nice -n 5 glab mr merge 3",
  "time gh pr merge 12",
  "sudo gh pr merge 17",
  "exec gh pr merge 12",
  "timeout 30 gh pr merge 17",
  "nohup gh pr merge 17",
  "stdbuf -oL gh pr merge 17",
  "oo gh pr merge 12 --squash",
  "! gh pr merge 12",
  "/usr/bin/gh pr merge 17",
  "./gh pr merge 17",
  "GH pr merge 17",
  "./g pr merge 17",
  "hubcli mr merge 4",
  "gh pr MERGE 17",
  // Quoting and escaping that hides the verb or the number.
  "\\gh pr merge 17",
  "gh pr mer\\\nge 17",
  "gh pr m$'\\x65'rge 17",
  "$'\\x67h' pr merge 17",
  "$'\\x67h' pr $'\\x6d\\x65rge' 17",
  "$'\\147\\150' pr $'\\155erge' 17",
  "$'\\u0067h' pr $'\\U0000006derge' 17",
  'gh pr m$"erge" 17',
  'gh pr merge 17 "unterminated',
  "gh pr merge '17",
  "{gh,pr,merge,17}",
  "gh pr {merge,view} 17",
  "gh pr merge 17 --subject é",
  "gh pr merge\v17",
  // Non-read gh verbs carrying a merge word: refused (use --body-file for prose).
  'gh pr comment 5 --body "please merge"',
  "gh pr comment 5 --body 'we will gh pr merge 12 later'",
  "gh pr edit 17 --add-label automerge",
  "gh pr review 17 --body '/merge'",
  "gh workflow run merge-release.yml",
  "gh run list --workflow merge.yml",
  "gh run rerun 42 --job merge",
  "gh release create v1 --notes merge",
  // Wrong targets and flags.
  "gh pr merge https://github.com/o/r/pull/17",
  "gh pr merge feature/x",
  "gh pr merge 017",
  "gh pr merge 0",
  "gh pr merge 99999999999999999999",
  "gh pr merge --squash 17",
  "gh pr merge 17 18",
  "gh pr merge 17 --admin",
  // Deferred merges run after the check, against a later head.
  "gh pr merge 17 --auto",
  "gh pr merge --squash --auto",
  "glab mr merge 12 --when-pipeline-succeeds",
  "glab mr merge 12 --auto-merge",
  "glab mr merge 12 --auto-merge=true",
  // A repo value never starts with a dash.
  "gh -R -x/y pr merge 17",
  "gh pr merge 17 --squash=true",
  "gh pr merge 17 -sd",
  "gh pr merge 17 --",
  "gh pr merge 17 --subject",
  "gh pr merge 17 --unknown",
  "gh pr merge view 17",
  "gh -R a/b pr merge 17 --repo c/d",
  "gh pr merge 17 -R a/b -R a/b",
  "gh pr merge 17 -R=a/b",
  "gh pr merge 17 -Ro/r",
  'gh pr merge 17 --repo="o/r;id"',
  "gh pr merge 17 --repo=",
  "gh pr merge 17 -R",
  "gh -R host/o/r pr merge 17",
  "gh -R o pr merge 17",
  "gh pr --repo o/r merge 17",
  "glab mr merge 3 -R a/b --repo c/d",
  "glab mr merge 3 --repo=a/b",
  "glab --project o/r mr merge 12",
  "glab mr merge 12 --auto-merge",
  "glab mr merge -m",
  "glab mr merge 12 --delete-branch",
  "glab pr merge 12",
  "glab mr accept 17",
  "glab mr accept 17 --squash",
  "glab -R g/p mr accept",
  "gh mr merge 12",
  // glab without the deferred-merge opt-out (#962 PM decision): refused.
  "glab mr merge 12",
  "glab mr merge",
  "glab -R g/p mr merge 3",
  "glab mr merge 12 --squash",
  "glab mr merge 12 --auto-merge false",
  "glab mr merge 12 -m --auto-merge=false",
  "glab mr merge 12 --sha --auto-merge=false",
  "glab mr merge 12 --message=--auto-merge=false",
  // REST, GraphQL, other clients — refused whatever the method.
  "gh api repos/o/r/pulls/12/merge",
  "gh api -X PUT repos/o/r/pulls/17/merge",
  "gh api repos/o/r/pulls/12/merge -X GET",
  'gh api repos/o/r/pulls/12/merge "-X GET"',
  "gh api repos/o/r/pulls/12/merge --method GET",
  "gh -R o/r api repos/o/r/pulls/17/merge",
  "glab api /projects/1/merge_requests/12/merge -X PUT",
  "glab api projects/1/merge_requests/17/merge",
  "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
  "curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge",
  "curl -X PUT -H 'PRIVATE-TOKEN: t' https://gitlab.example.com/api/v4/projects/1/merge_requests/2/merge",
  "wget --method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
  "http PUT api.github.com/repos/o/r/pulls/1/merge",
  "hub merge https://github.com/o/r/pull/1",
  // #1417 — the size bound (#955): a merge-shaped command too long to read is
  // held, not resolved to the current branch's PR.
  longMergeCommand(),
  // #1417 — a creation that carries an INLINE body is no longer exempt, so a
  // merge word in the body the agent typed reaches the trigger. (`--body-file`
  // stays exempt — see NOT_MERGES and BODY_FLAGS in merge-allowlist.ts.)
  'gh pr create --title x --body "gh pr merge 12"',
  'gh issue create --title x --body "gh pr merge 12"',
  'gh pr create --title x --body "merge"',
  'gh pr create --title x -b "merge the branch"',
  'gh issue create --title x --body="please merge"',
  // Prose that names a merge next to a forge.
  'echo "gh pr merge 12"',
  'git commit -m "docs: explain gh pr merge 12"',
  "grep -rn 'gh pr merge' .",
  "gh alias set m 'pr merge'",
];

/**
 * `[command, bare-reason-code, detail-must-appear]` — the stable name the
 * reader reports. #1417 LOW split the two: `reason` is EXACTLY the code (a
 * clause naming the offending word used to be appended to it, which broke any
 * consumer that compared it), and `detail` carries that clause. Both are
 * asserted so neither half can silently go missing. The third element is
 * optional — rows without it pin only the code.
 */
export const CODES: Array<[string, string, string?]> = [
  ["gh pr merge 17 --admin", "unknown-flag", "the offending word is `--admin`"],
  ["gh -R o pr merge 17", "repo-value"],
  ["gh -R host/o/r pr merge 17", "repo-count"],
  ["gh pr merge feature/x", "not-a-number", "the offending word is `feature/x`"],
  ["gh pr merge 17 18", "extra-command", "the offending word is `18`"],
  ["gh pr merge 17 -R", "repo-value"],
  ["gh pr merge 17 --subject", "flag-missing-value"],
  ["cd x && gh pr merge 17", "forbidden-char:&", "triggered by a merge verb pair"],
  ["gh pr merge 17 --body-file ~/x.md", "forbidden-char:~"],
  ['gh pr merge 17 --subject "feat!: x"', "forbidden-char:!"],
  ['gh pr merge 17 "unterminated', "quote-unbalanced", "an unbalanced quote"],
  ["gh pr merge 17 --subject é", "control-or-non-ascii", "a control or non-ASCII character"],
  ["gh api repos/o/r/pulls/1/merge", "not-pr-merge", "the offending word is `api`"],
  ["glab mr merge 12", "glab-auto-merge"],
  ['g"h" pr merge 17', "expansion-command-word", "a command word built by expansion"],
  ["$G api repos/o/r/pulls/17/merge -X PUT", "expansion-command-word"],
  ["gh api graphql -F query=@q.graphql", "body-indirect", "a forge/HTTP request whose body"],
  ["./gh pr merge 17", "not-a-forge-command", "the command word is `./gh`"],
  // #1417 — the size bound (#955), restored: an unanalysably long
  // forge-naming command is held, never resolved to the current branch's PR.
  // Built by `longMergeCommand` so the row stays readable; it is
  // >MERGE_COMMAND_SIZE_BOUND by construction.
  [longMergeCommand(), "too-large", "past the bound the guard will read"],
  // #1417 — a `gh pr create` / `issue create` that POSTS a body is no longer
  // exempt, so a merge word cannot be smuggled through the one exempt verb
  // whose argument reaches the forge verbatim.
  ['gh pr create --title x --body "gh pr merge 12"', "not-pr-merge", "expected `pr merge` here"],
];

/**
 * The #1317 expansion / control-flow canaries, restored (#1417 HIGH).
 *
 * `test-merge-guard-1317.ts` was deleted with the matcher it tested, and its
 * shapes were not carried into the tables above — so the class of bug that
 * file existed to pin (a substitution glued to the command word; a `case`
 * arm; a brace-built verb; an expansion in the verb position) went unguarded.
 * Each row is one shape the OLD matcher gated, with the verdict the new
 * classifier produces for it. A shape whose verdict is `"none"` is inert — it
 * spells no merge word and cannot be read as one, which is the documented
 * residual rather than a bypass — and is named as such here rather than being
 * silently dropped.
 *
 * Ground truth for the old behaviour: `git show
 * c26dd86^:extension/smoke-tests/test-merge-guard-1317.ts` (the file before
 * the #962 rewrite deleted it). What the old matcher called `unparsed`,
 * `unrecognised` and `multiple` all collapse to `refused` under the strict
 * allowlist; what it called `merge` for a shape the guard now refuses to read
 * at all is the deliberate over-refusal #962 chose.
 */
export const EXPANSION_CANARIES: Array<[string, "refused" | "none", string?]> = [
  // A. a substitution GLUED to the command word. Old: `merge` (read the PR).
  // Now: held. The old matcher could tell `$(true)gh pr merge 12` from
  // `gh pr merge 12`; the allowlist cannot read the word bash would exec, so
  // it holds all three rather than guess. Over-refusal, never a bypass.
  ["$(true)gh pr merge 12", "refused", "expansion-command-word"],
  ["`true`gh pr merge 4 ", "refused", "forbidden-char:`"],
  ["$(echo x)gh pr merge 9", "refused", "expansion-command-word"],
  // A quoted command word glued to a substitution: still held, and still for
  // the expansion, not for a quote that never closes.
  ['$(true)"gh" pr merge 12', "refused", "expansion-command-word"],
  // 6. `case … esac`. Old: `merge` — the matcher walked the arms and read
  // the merge inside them. Now: held on the `)` the grammar forbids.
  ["case x in a) gh pr merge 17", "refused", "forbidden-char:)"],
  ["case x in a) gh pr merge 17;; esac", "refused", "forbidden-char:)"],
  // 4. brace expansion. Old: the matcher ENUMERATED `{gh,pr,merge,17}` and
  // read it as a merge of #17. Now: held — the words bash runs are unknown.
  ["{gh,pr,merge,17}", "refused", "brace-expansion"],
  // 4b. the same brace pattern beside `view`: old `unreadable`, now held.
  ["gh pr {merge,view} 17", "refused", "brace-expansion"],
  // 4c. past the expansion bound (the old matcher refused past 256
  // alternatives). Here the run is so long the merge word never appears even
  // in the widened view, so nothing triggers — the old matcher still gated it
  // (`unparsed`, past its bound); the allowlist answers `none`, which is the
  // named inert residual rather than a refusal. Pinned so a future trigger
  // change that makes this row `refused` is a deliberate decision, not drift.
  [`gh pr m{${Array.from({ length: 300 }, (_, i) => `x${i}`).join(",")},erge} 17`, "none"],
  // C. an expansion in the VERB position. The merge word never appears
  // literally, so nothing triggers: the documented inert residual, listed
  // explicitly because the old matcher DID gate it.
  ["gh pr m$X 17", "none"],
  ["X=erge; gh pr m$X 17", "none"],
  ["gh pr m$(echo e)rge 17", "none"],
  // B. an unreadable PR number. Old: `unreadable`. Now: held — never the
  // current branch's PR, which is the #955 failure this class pins.
  ["gh pr merge $PR", "refused", "forbidden-char:$"],
  ['gh pr merge "$N"', "refused", "forbidden-char:$"],
  ["gh pr merge 1 $X", "refused", "forbidden-char:$"],
  // 5. ANSI-C escapes spelling the verb. Old: `merge` (decoded and read).
  // Now: held on the `$` the grammar forbids — the `$'…'` form is a trigger
  // the widened view decodes, but the strict lexer will not read it, so the
  // refusal is the forbidden character rather than the expansion rule.
  ["gh pr $'\\x6derge' 17", "refused", "forbidden-char:$"],
  ["gh pr $'\\155erge' 17", "refused", "forbidden-char:$"],
  ["gh pr $'\\u006derge' 17", "refused", "forbidden-char:$"],
  // 3. a single `&` separator hiding a second merge. Old: `multiple`.
  ["gh pr merge 17 & gh pr merge 5", "refused", "forbidden-char:&"],
  // 1. an unparseable canonical reading: an apostrophe inside a quoted
  // heredoc body. Old: `unparsed`. Now: held — the segment's command word is
  // quoted, which is the expansion rule, not a quote-balance failure.
  ["cat <<'EOF'\ndon't\nEOF\ngh pr merge 17", "refused", "expansion-command-word"],
  // A substitution anywhere: nothing is exempt, the merge is held.
  ["echo $(\\gh pr merge 12)", "refused", "expansion-command-word"],
  ["git commit -m x $(\\gh pr merge 12)", "refused", "expansion-command-word"],
  // The `bash -c WORD` exemption the old review removed: held, over-refused.
  ["bash -c gh pr merge 17", "refused", "not-a-forge-command"],
  // A REST merge with no readable number. Old: `unreadable`; now: held on the
  // path it cannot match to the one merge form.
  ["gh api pulls/merge -X PUT", "refused", "not-pr-merge"],
  // The xargs / alias indirections the docs named: held, never "not a merge".
  ["echo 17 | xargs -I{} gh pr merge {}", "refused", "forbidden-char:|"],
  ["alias m='gh pr merge'; m 17", "refused", "forbidden-char:;"],
];

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
