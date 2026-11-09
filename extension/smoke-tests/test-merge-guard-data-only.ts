#!/usr/bin/env bun
/**
 * #2125 — the data-only merge exemption: a command that mentions a merge only
 * in DATA (a quoted argument, a commit message, a grep pattern, an inert
 * writer's heredoc body) is freed to `none`, because no segment bash would
 * EXECUTE spells a merge.
 *
 * The predicate (merge-data-only.ts) is the guard's data view. It is safe in
 * two directions and this file pins both:
 *   1. It frees the prose shapes the raw-text trigger over-held — but ONLY
 *      when the whole command parses in its small grammar.
 *   2. It NEVER frees a command that could run a merge: `eval`/`.`/`source`
 *      run their argument, `alias`/`export` defer one, a writer redirected to
 *      a file (`> x.sh`) stages one, a bare (unquoted) forge verb pair on an
 *      unresolvable command word (`GH pr merge`, `./g pr merge`, `hubcli mr
 *      merge`) is held, and an unquoted `$ \` \` \ ( ) { } …` answers false.
 * Every "false" is the safe direction: the command falls through to the raw
 * trigger and is judged exactly as before this module existed.
 */

import { dataOnlyMergeMention } from "../src/merge-data-only.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

// ------------------------------------------------------------ freed: data only
// Each names a merge only in text bash hands a program as an argument or as
// input to an inert writer — no executed segment spells it.
const FREED: string[] = [
  'echo "gh pr merge 12"',
  "git commit -m \"docs: explain gh pr merge 12\"",
  "grep -rn 'gh pr merge' .",
  "grep -c \"gh pr merge\" docs/troubleshooting.md",
  "vipune add 'the gh pr merge flow is unchanged'",
  // A grep pattern that merely quotes the verb pair, beside a pipe to a reader.
  "git grep -n \"gh pr merge\" -- src/forge.ts | head",
];
for (const cmd of FREED) {
  assert(dataOnlyMergeMention(cmd) === true, `data-only mention freed: ${JSON.stringify(cmd)}`);
}

// ------------------------------------------------------------ held: could execute
// Each COULD run a merge, so the predicate refuses to exempt it (returns
// false), and the raw trigger holds it. A single `true` here is a bypass.
const HELD: string[] = [
  // eval / dot-source / source run their argument as shell code.
  'eval "gh pr merge 1"',
  "eval gh pr merge 1",
  // alias / export define a command bash runs later.
  "alias m='gh pr merge'; m 17",
  // A writer redirected to a file that a later segment could run.
  "printf 'gh pr merge 1' > x.sh; sh x.sh",
  "echo gh pr merge 12 > x.sh; sh x.sh",
  // A pipe into a shell executes the writer's text.
  "echo gh pr merge 12 | sh",
  "printf 'gh pr merge 12' | bash",
  // A heredoc whose reader is a shell/interpreter runs the body.
  "sh <<'EOF'\ngh pr merge 1\nEOF",
  "python3 - <<'PY'\nprint('gh pr merge 12')\nPY",
  // A bare (unquoted) forge verb pair on a command word the scanner cannot
  // resolve to a known tool — the base classifier holds these too.
  "GH pr merge 17",
  "./g pr merge 17",
  "hubcli mr merge 4",
  // The forge CLI present in any position executes what its words name.
  "oo gh pr merge 12 --squash",
  "timeout 5 gh pr merge 12",
];
for (const cmd of HELD) {
  assert(dataOnlyMergeMention(cmd) === false, `could-execute shape not exempted: ${JSON.stringify(cmd)}`);
}

// ------------------------------------------------------------ held: out of grammar
// Any shape outside the small grammar answers false, so it is judged on its
// raw text exactly as before this module.
const OUT_OF_GRAMMAR: string[] = [
  "$(true)gh pr merge 12", // a substitution the scanner cannot place
  "cat <<EOF\ngh pr merge 1\nEOF", // an UNQUOTED delimiter: the body expands
  "echo ${MERGE} pr merge 12", // an expansion
  "gh pr merge 12 && gh pr merge 13", // (still false: an executed merge, not the grammar)
  "cat 'unterminated", // an unbalanced quote
  "echo gh pr merge 12 >&2", // a descriptor duplication it cannot read
];
for (const cmd of OUT_OF_GRAMMAR) {
  assert(dataOnlyMergeMention(cmd) === false, `out-of-grammar shape not exempted: ${JSON.stringify(cmd)}`);
}

// ------------------------------------------------------------ no merge word: false
// A command spelling no merge is not the predicate's business; it answers
// false and the trigger never fires on it anyway.
const NO_MERGE: string[] = ["ls -la", "git status", "grep -rn 'foo' .", "cat > f <<'EOF'\nhi\nEOF"];
for (const cmd of NO_MERGE) {
  assert(dataOnlyMergeMention(cmd) === false, `no merge word: ${JSON.stringify(cmd)}`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
