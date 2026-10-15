#!/usr/bin/env bun
/**
 * #962 review round — indirect request bodies, brace-built verbs, out-of-range
 * ANSI-C escapes, and merge words in the arguments of read-only gh subcommands
 * (merge-allowlist.ts). The strict grammar is covered by
 * test-merge-guard-allowlist.ts; this file covers the trigger gaps and the
 * usability exemption added after that round.
 */

import { readMergeCommand } from "../src/merge-allowlist.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const kind = (cmd: string) => readMergeCommand(cmd).kind;

// ------------------------------------------------------------ indirect bodies
const BODY_INDIRECT: string[] = [
  'gh api graphql -f query="$(cat q.graphql)"',
  "gh api graphql -f query=`cat q`",
  'curl -d "$(cat body.json)" https://api.github.com/graphql',
  "curl -T body.json https://api.github.com/graphql",
  "wget --post-file=body.json https://api.github.com/graphql",
  "wget --post-file body.json https://api.github.com/graphql",
  "curl -d @body.json https://api.github.com/graphql",
  "curl --data-binary @body.json https://api.github.com/graphql",
  "curl -F file=@x.bin https://api.github.com/repos/o/r/issues",
  "gh api graphql -F query=@q.graphql",
  "gh api -F title=@t.md repos/o/r/issues",
  "gh api graphql --input q.json",
  "gh api graphql -f query=$Q",
  "gh api repos/o/r/pulls/$N",
  "http POST api.github.com/graphql query=@q.graphql",
];
for (const cmd of BODY_INDIRECT) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === "refused" && m.reason === "body-indirect",
    `body-indirect refused: ${JSON.stringify(cmd)} (${JSON.stringify(m)})`,
  );
}
// Literal bodies stay allowed: a GraphQL query inside single quotes is bash-literal.
for (const cmd of [
  "gh api graphql -f query='{ viewer { login } }'",
  "gh api repos/o/r/pulls/17",
  "glab api graphql -f query='{ currentUser { username } }'",
  "curl https://api.github.com/repos/o/r/pulls/17",
]) {
  assert(kind(cmd) === "none", `literal body allowed: ${JSON.stringify(cmd)}`);
}

// ------------------------------------------------------------ brace expansion
for (const cmd of ["gh pr m{erge,} 17", "glab mr merg{e,}", "gh pr {merge,view} 17", "gh pr m{e..e}rge 17"]) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === "refused" && m.reason === "brace-expansion",
    `brace-expansion refused: ${JSON.stringify(cmd)} (${JSON.stringify(m)})`,
  );
}
// A brace inside quotes is literal to bash and does not trigger.
assert(kind("gh pr view 17 --jq '{a,b}'") === "none", "brace inside single quotes is literal");
assert(kind('gh pr view 17 --jq "{a,b}"') === "none", "brace inside double quotes is literal");

// ------------------------------------------------------------ ANSI-C literal
// An out-of-range or unreadable escape is kept literal, so the text is not
// rebuilt into a merge word the shell would never produce.
for (const cmd of ["gh pr m$'\\U00110067'erge 17", "gh pr m$'\\xZZ'erge 17"]) {
  assert(kind(cmd) !== "merge", `ANSI-C out-of-range escape is not read as a merge: ${JSON.stringify(cmd)}`);
}
{
  const m = readMergeCommand("$'\\U00110067gh' pr merge 17");
  assert(m.kind === "refused", `ANSI-C prefix on the command word is refused (${JSON.stringify(m)})`);
}

// ------------------------------------------------------------ read-only gh
for (const cmd of [
  'gh pr create --title "fix(review): refuse merge shapes" --body-file x.md',
  'gh pr list --search "merge conflict"',
  "gh pr view 17 --jq '.labels[]|select(.name==\"merge-ready\")'",
  'gh pr comment 5 --body "please merge"',
  'gh issue create --title "merge the thing" --body-file b.md',
  "gh run list --workflow merge.yml",
  'gh search code "merge" --repo o/r',
]) {
  assert(kind(cmd) === "none", `read-only gh with merge prose allowed: ${JSON.stringify(cmd)}`);
}
for (const cmd of [
  "gh pr create --title x; gh pr merge 5",
  "gh alias set m 'pr merge'",
  'gh pr create --title "x" --body "$(gh pr merge 5)"',
  "gh pr view 17 --title x && gh pr merge 5",
]) {
  assert(kind(cmd) === "refused", `merge hidden behind a read-only verb is refused: ${JSON.stringify(cmd)}`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
