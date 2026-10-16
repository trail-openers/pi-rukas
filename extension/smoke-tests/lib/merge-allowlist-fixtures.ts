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
  // Prose that names a merge next to a forge.
  'echo "gh pr merge 12"',
  'git commit -m "docs: explain gh pr merge 12"',
  "grep -rn 'gh pr merge' .",
  "gh alias set m 'pr merge'",
];

/**
 * `[command, reason-code]` — the stable name the reader reports. Since #1417
 * the grammar appends a clause naming the offending word AFTER the code, so
 * `reason` merely has to START with these.
 */
export const CODES: Array<[string, string]> = [
  ["gh pr merge 17 --admin", "unknown-flag"],
  ["gh -R o pr merge 17", "repo-value"],
  ["gh -R host/o/r pr merge 17", "repo-count"],
  ["gh pr merge feature/x", "not-a-number"],
  ["gh pr merge 17 18", "extra-command"],
  ["gh pr merge 17 -R", "repo-value"],
  ["gh pr merge 17 --subject", "flag-missing-value"],
  // #1417 — the reason CODE stays the stable name; the clause the grammar
  // appends (naming the offending word) lives after it, so `reason` starts
  // with the code.
  ["cd x && gh pr merge 17", "forbidden-char:&"],
  ["gh pr merge 17 --body-file ~/x.md", "forbidden-char:~"],
  ['gh pr merge 17 --subject "feat!: x"', "forbidden-char:!"],
  ['gh pr merge 17 "unterminated', "quote-unbalanced"],
  ["gh pr merge 17 --subject é", "control-or-non-ascii"],
  ["gh api repos/o/r/pulls/1/merge", "not-pr-merge"],
  ["glab mr merge 12", "glab-auto-merge"],
  ['g"h" pr merge 17', "expansion-command-word"],
  ["$G api repos/o/r/pulls/17/merge -X PUT", "expansion-command-word"],
  ["gh api graphql -F query=@q.graphql", "body-indirect"],
  ["./gh pr merge 17", "not-a-forge-command"],
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
