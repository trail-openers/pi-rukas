/**
 * test-reviewer-write-positions-2352 — the words a reviewer's write guard cannot
 * trust, in the spellings the shared lexer reports them literally (#2352 fix wave).
 *
 * Two shapes the C1 probe found, both of which made a write look resolvable:
 *
 *   - a SINGLE-quoted word keeps its text verbatim and is not marked dynamic, so
 *     `cp x '$T/pwned'` handed the judge the text `$T/pwned`, resolved it against
 *     the child's cwd, found it inside the roots, and let the shell expand `$T`
 *     afterwards. Same for a backslash-escaped `\$` and a backtick. The double-quoted
 *     spelling was always refused, because the lexer marks it `dyn`.
 *   - an interpreter body in single quotes reaches the judge as literal text, so
 *     `python3 -c 'open("/abs/x","w")'` named no write position at all where the
 *     double-quoted spelling is refused.
 *
 * The guard reads only what the shared lexer/splitter/writers produce, so these
 * cases are driven through `firstReviewerWriteOutside` — the same entry the
 * registered hook uses — rather than at the judge's internals.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHILD_TMP_ENV } from "../src/write-fence-deletion.ts";
import { firstReviewerWriteOutside, reviewerRootsFrom } from "../src/write-fence-reviewer.ts";

const root = mkdtempSync(path.join(tmpdir(), "rf-pos-2352-"));
const worktree = path.join(root, "wt");
const childTmp = path.join(root, "ct");
const outside = path.join(root, "operator");
for (const d of [worktree, childTmp, outside]) await Bun.write(path.join(d, ".keep"), "");
const roots = reviewerRootsFrom({ [CHILD_TMP_ENV]: childTmp }, worktree);

/** Refused, with a reason that says the path could not be resolved. */
function refused(label: string, command: string) {
  const hit = firstReviewerWriteOutside(command, roots);
  assert.ok(hit !== undefined, `refused: ${label} — ran instead`);
  assert.ok(hit.reason.length > 20, `${label}: the refusal names a reason`);
}

function allowed(label: string, command: string) {
  const hit = firstReviewerWriteOutside(command, roots);
  assert.equal(hit, undefined, `allowed: ${label}${hit ? ` — ${hit.reason}` : ""}`);
}

console.log("── C1: a single-quoted $ at a write position is not a literal path ──");
const quotedDollar = [
  "cp",
  "mv",
  "touch",
  "tee",
  "mkdir",
  "install",
  "ln",
  "link",
  "truncate",
];
for (const verb of quotedDollar) {
  // The target is RELATIVE, which is the shape that was actually exploited: a
  // quoted `$T` resolves against the child's cwd, which is one of its roots, so a
  // judge that trusted the text called it allowed. The absolute spelling is refused
  // for the wrong reason (its literal text lies outside) and proves nothing.
  const target = `'$T/${verb}/pwned'`;
  const operand = verb === "ln" || verb === "link" ? `x ${target}` : target;
  refused(`single-quoted $T through ${verb}`, `${verb} ${operand}`);
}
refused("single-quoted $T as dd's of=", `dd if=/dev/null of='$T/dd'`);
refused("an escaped dollar sign the shell un-escapes", `touch \\${outside}/\\$T/x`);
refused("a backtick the shell expands", `touch \`${outside}/\${id}/x\``);
// The spellings that were already refused stay refused.
refused("the double-quoted spelling (already refused)", `cp x "$T/pwned"`);
refused("the unquoted spelling (already refused)", `cp x $T/pwned`);
refused("a single-quoted glob (already refused)", `touch '$T/*'`);
refused("a single-quoted brace list (already refused)", `touch '$T/{a,b}'`);

console.log("── C1: an interpreter body in single quotes is read as a body ──");
refused("python3 -c in single quotes", `python3 -c 'open("/abs/x","w")'`);
refused("python -c in single quotes", `python -c 'open("/abs/x","w")'`);
refused("node -e in single quotes", `node -e 'require("fs").writeFileSync("/abs/x","a")'`);
refused("bun -e in single quotes", `bun -e 'require("fs").writeFileSync("/abs/x","a")'`);
refused("perl -e in single quotes", `perl -e 'open F, ">", "/abs/x"'`);
refused("ruby -e in single quotes", `ruby -e 'File.write("/abs/x", "a")'`);
refused("the double-quoted python spelling (already refused)", `python3 -c "open('/abs/x','w')"`);
// A body that writes nothing still runs: this is a reviewer's probe arm, not a ban.
allowed("a read-only python probe", `python3 -c 'print(open("${outside}/memory.json").read())'`);
allowed(
  "a read-only node probe",
  `node -e 'console.log(require("fs").readFileSync("${outside}/index.ts","utf8"))'`,
);

console.log("── C1: a single-quoted literal inside the roots is still a literal ──");
allowed("a single-quoted path in its own tree", `touch '${worktree}/notes.md'`);
allowed("a single-quoted path in its scratch", `mkdir -p '${childTmp}/a b'`);
allowed("a single-quoted copy into its tree", `cp ${outside}/x '${worktree}/copy.json'`);
allowed("a single-quoted read", `cat '${outside}/memory.json'`);
allowed("a single-quoted path with a space and a comma", `touch '${worktree}/a b,c.md'`);

rmSync(root, { recursive: true, force: true });
console.log("\nreviewer write positions (#2352 C1): all groups passed");
