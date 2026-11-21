#!/usr/bin/env bun
/**
 * The merge guard holds a chain only when one of its commands is a merge, and
 * holds an API call with an unread body only when its endpoint could merge.
 *
 * RUN pins the shapes a triage session issues — a heredoc whose prose says
 * "merge" then a `--body-file` comment, `git merge-base` beside a `gh` read,
 * a literal issue endpoint fed a body file — as `none`. HOLD pins that the
 * split is not a way round the guard: a merge anywhere in the chain, a value
 * assembled by expansion, a script written then run, a heredoc fed to a shell,
 * and every endpoint that can merge (GraphQL, `…/merge`, one not readable)
 * stay held.
 */

import { readMergeCommand } from "../src/merge-allowlist.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const RUN: string[] = [
  "cat > /tmp/b.md <<'EOF'\nThis waits on the merge of #12; don't rush it.\nEOF\ngh issue comment 5 --repo o/r --body-file /tmp/b.md",
  "mkdir -p tmp && cat > tmp/b.md <<'EOF'\nmerge after CI\nEOF\ngh issue edit 5 --body-file tmp/b.md && gh issue edit 5 --add-label tehas:next",
  "git fetch && git merge-base HEAD origin/main && gh pr view 3",
  "cd /repo && git log --merges -5 && gh pr list --state open",
  "gh api repos/o/r/issues/5/comments -F body=@/tmp/b.md",
  "gh api repos/o/r/issues/5/comments --input /tmp/b.json",
  'gh api repos/o/r/issues/5 -X PATCH -f body="$(cat /tmp/b.md)"',
  "cd /repo && gh api repos/{owner}/{repo}/issues/5/comments --input /tmp/b.json",
];

const HOLD: string[] = [
  "cd x && gh pr merge 3",
  "git fetch\ngh pr merge 3 --squash",
  "cd x && glab mr merge 3 --auto-merge=false",
  "X=merge; gh pr $X 3",
  "echo gh pr merge 12 > x.sh; sh x.sh",
  "cat > x.sh <<'EOF'\ngh pr merge 3\nEOF\nsh x.sh",
  "bash <<'EOF'\ngh pr merge 3\nEOF",
  "echo ok && gh pr merge 3 | cat",
  "cd x && gh issue edit 5 --add-label merge-ready",
  'gh api graphql -f query="$(cat q.graphql)"',
  "gh api graphql --input q.json",
  "gh api repos/o/r/pulls/5/merge -X PUT --input b.json",
  "gh api projects/1/merge_requests/2/merge -X PUT --input b.json",
  'gh api -X PUT "$URL" --input b.json',
  "gh api repos/o/r/$P --input b.json",
  "gh api repos/o/r/issues/5/comments --input a.json && gh api graphql --input q.json",
  "curl -X PUT https://api.github.com/repos/o/r/issues/1/comments -d @b.json",
];

for (const cmd of RUN) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === "none",
    `runs: ${JSON.stringify(cmd.slice(0, 70))} (${JSON.stringify(m).slice(0, 120)})`,
  );
}
for (const cmd of HOLD) {
  const m = readMergeCommand(cmd);
  assert(m.kind !== "none", `held: ${JSON.stringify(cmd.slice(0, 70))}`);
}
console.log(`\nexit ${exit}`);
process.exit(exit);
