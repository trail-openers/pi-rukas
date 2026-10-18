#!/usr/bin/env bun
/**
 * #1559 — the merge guard decides on the COMMAND WORD: text written to a file
 * by `cat` / `printf` / `echo` is not a forge call, whatever its body says.
 *
 * The incident: an explore child parking an issue wrote its own verdict file
 * (`cat > tmp/issue-301/spec.md <<'EOF' …`, then `printf … > spec.md`) and was
 * held four times, because the issue text it quoted back spelled a merge next
 * to a forge word. The first half below pins those shapes (and their
 * relatives) as `none`, at the classifier and through the real hook with zero
 * forge calls. The second half pins that the exemption is NOT a way round the
 * guard: every shape that runs something other than a text writer, or hides a
 * substitution, still reaches the trigger and is held. The full #962 refusal
 * table in test-merge-guard-allowlist.ts covers the rest.
 */

import type { MergeCommand } from "../src/merge-allowlist.ts";
import { readMergeCommand } from "../src/merge-allowlist.ts";
import { isInertFileWrite } from "../src/merge-inert-write.ts";
import { REFUSED } from "./lib/merge-allowlist-fixtures.ts";
import {
  GOOD_ENTRIES,
  assert,
  exit,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";

const show = (m: MergeCommand) => JSON.stringify(m).slice(0, 160);

// ------------------------------------------------------------ the incident shapes
const WRITES: string[] = [
  // The four held commands of cycle 301-261017-200621, as reported.
  "cat > tmp/issue-301/spec.md <<'EOF'\nINTENT-VERDICT: park\nPARK-REASON: already-implemented\n## Spec\nThe dispatcher stops; a PR can still merge via gh when CI passes.\nEOF",
  "printf '%s\\n' 'INTENT-VERDICT: park' 'PARK-REASON: already-implemented' '' '## Spec' '' '### Intent' 'honoured by the dispatcher; the PR merge flow in gh is unchanged.' > tmp/issue-301/spec.md",
  // Prose that spells the merge form outright, in every quoting.
  "echo 'after gh pr merge 12 the loop drains' > tmp/x.md",
  'echo "run gh pr merge 12 --squash once CI is green" >> tmp/x.md',
  "printf 'see https://api.github.com/repos/o/r/pulls/1/merge\\n' > notes.md",
  "printf 'mutation { mergePullRequest(input: {}) }' > q.txt",
  // Unquoted heredoc with no substitution, `<<-`, double-quoted delimiter.
  "cat > f.md <<EOF\ngh pr merge 12 is the merge form; $HOME stays literal enough\nEOF",
  'cat > f.md <<-"EOF"\n\tglab mr merge 3\n\tEOF',
  // Chained writes, mkdir first, expansions in the target path.
  "mkdir -p tmp/issue-301 && cat > tmp/issue-301/spec.md <<'EOF'\nwe do not gh pr merge here\nEOF",
  "printf '%s\\n' 'gh pr merge 1' > \"$SCRATCH/a.md\"; printf '%s\\n' 'merge again' >> \"${SCRATCH}/a.md\"",
  "cat > a.md <<'A'\ngh pr merge 1\nA\ncat > b.md <<'B'\ncurl -X PUT …/merge\nB",
  "cat > a.md <<'A' && cat > b.md <<'B'\ngh pr merge 1\nA\nglab mr merge 2\nB",
  // An apostrophe in a quoted heredoc body is literal (cf. the refused
  // `cat <<'EOF'\ndon't\nEOF\ngh pr merge 17`, where a command follows).
  "cat > f.md <<'EOF'\ndon't gh pr merge 17\nEOF",
];
for (const cmd of WRITES) {
  assert(isInertFileWrite(cmd), `inert write: ${JSON.stringify(cmd.slice(0, 70))}`);
  const m = readMergeCommand(cmd);
  assert(m.kind === "none", `not a merge: ${JSON.stringify(cmd.slice(0, 70))} (${show(m)})`);
}
// A long verdict file is a write too: the exemption sits ahead of the size bound.
const longWrite = `cat > spec.md <<'EOF'\n${"the gh pr merge flow is unchanged\n".repeat(400)}EOF`;
assert(longWrite.length > 8000, "the long write is past the size bound");
assert(readMergeCommand(longWrite).kind === "none", "a long text write is not held by the bound");

// ------------------------------------------------------------ not a way round the guard
const NOT_WRITES: string[] = [
  // Stdout is not a file: still judged by the trigger (#962's own table).
  'echo "gh pr merge 12"',
  // A substitution bash would run, wherever it hides.
  'echo "$(gh pr merge 1)" > f',
  "echo `gh pr merge 1` > f",
  "cat > f <<EOF\n$(gh pr merge 1)\nEOF",
  "cat > f <<EOF\n`gh pr merge 1`\nEOF",
  "cat > f <(gh pr merge 1)",
  "echo x >(gh pr merge 1)",
  "x=$(gh pr merge 1) echo > f",
  // ANSI-C: `\'` does not close the quote, so the scanner would desync.
  "echo $'x\\' ' $(gh pr merge 1) '' > f",
  // A command after (or beside) the write.
  "cat > f <<'EOF'\nx\nEOF\ngh pr merge 17",
  "echo x > f\ngh pr merge 1",
  "echo x > f; gh pr merge 17",
  "echo x > f && gh pr merge 17",
  "echo x > f || gh pr merge 17",
  "echo x > f & gh pr merge 1",
  "printf 'gh pr merge 1' | bash",
  "printf 'gh pr merge 1' > x.sh; sh x.sh",
  // A heredoc delimiter glued to more text ends at a different line in bash.
  "cat > f <<E\\OF\nx\nEOF\ngh pr merge 1\nE",
  "cat > f <<'EOF'x\ngh pr merge 1\nEOFx",
  // Unterminated heredoc, here-string, unbalanced quote, comment.
  "cat > f <<'EOF'\ngh pr merge 1",
  'cat > f <<< "gh pr merge 1"',
  "echo 'gh pr merge 1 > f",
  "echo x > f # gh pr merge 1",
  // Not a text writer, or a writer spelled so its word is not readable.
  "bash -c 'gh pr merge 1' > f",
  'eval "gh pr merge 1" > f',
  "env echo gh pr merge 1 > f",
  "FOO=1 echo gh pr merge 1 > f",
  "\"cat\" > f <<'EOF'\ngh pr merge 1\nEOF",
  "\\echo gh pr merge 1 > f",
  "$E gh pr merge 1 > f",
  "tee f <<'EOF'\ngh pr merge 1\nEOF",
  "{ echo gh pr merge 1; } > f",
  "(echo gh pr merge 1) > f",
  // Redirections that are not a plain file.
  "printf 'PUT /repos/o/r/pulls/1/merge' > /dev/tcp/api.github.com/80",
  "echo gh pr merge 1 >&2",
  "echo gh pr merge 1 2> f",
  "> f",
  "",
];
for (const cmd of NOT_WRITES) {
  assert(!isInertFileWrite(cmd), `not an inert write: ${JSON.stringify(cmd.slice(0, 70))}`);
}
// Each one that spells a merge is still held by the classifier.
for (const cmd of NOT_WRITES.filter((c) => /merge/.test(c))) {
  const m = readMergeCommand(cmd);
  assert(m.kind !== "none", `still held: ${JSON.stringify(cmd.slice(0, 70))} (${show(m)})`);
}
// And no #962 bypass shape is an inert write.
for (const cmd of REFUSED) {
  assert(!isInertFileWrite(cmd), `no #962 refused shape is exempt: ${JSON.stringify(cmd)}`);
}

// ------------------------------------------------------------ the hint
// A held command that starts like a text write is told what would pass.
const held = readMergeCommand('echo "gh pr merge 12"');
assert(
  held.kind === "refused" && (held.detail ?? "").includes("a text write is never held"),
  `a held echo names the write that is never held (${show(held)})`,
);
const heldChain = readMergeCommand("printf 'gh pr merge 1' | bash");
assert(
  heldChain.kind === "refused" &&
    (heldChain.detail ?? "").includes("`pr merge`") &&
    (heldChain.detail ?? "").includes("a text write is never held"),
  `a held printf chain names the token and the write that passes (${show(heldChain)})`,
);
const heldMerge = readMergeCommand("gh pr merge 17 | cat");
assert(
  heldMerge.kind === "refused" && !(heldMerge.detail ?? "").includes("a text write"),
  `a held gh command carries no write hint (${show(heldMerge)})`,
);

// ------------------------------------------------------------ through the real hook
await setupLedgerPath();
for (const cmd of WRITES.slice(0, 2)) {
  const r = await hookDecision(cmd, []);
  assert(
    !r.block && r.calls.length === 0,
    `hook runs the verdict write untouched: ${JSON.stringify(cmd.slice(0, 50))} (${(r.reason ?? "").slice(0, 80)})`,
  );
}
for (const cmd of ["cat > f <<'EOF'\nx\nEOF\ngh pr merge 17", 'echo "$(gh pr merge 1)" > f']) {
  const r = await hookDecision(cmd, GOOD_ENTRIES);
  assert(r.block === true, `hook still holds a merge beside a write: ${JSON.stringify(cmd)}`);
}
teardownLedger();

console.log(`\nexit ${exit}`);
process.exit(exit);
