#!/usr/bin/env bun
/**
 * #1764 — the five modules' changed behaviour, pinned at UNIT level.
 *
 * The corpus and case tables show what the guard does to a WHOLE command; this suite
 * pins the pieces, because each of the five modules changed and a whole-command test
 * cannot tell which piece regressed when the composition is what it asserts:
 *
 *  - `review-accept-command.ts` — a heredoc with a QUOTED delimiter parses (it used to
 *    be a PARSE_FAIL, which threw the whole command into the unreadable branch), and a
 *    backslash-escaped quote no longer ends a double-quoted span (which used to split a
 *    `--jq "…\"|\"…" filter into two shell segments).
 *  - `review-accept-views.ts` — the name test's subject masks prose option values and
 *    keeps heredoc bodies; the expansion test's subject drops the bodies; an assignment
 *    the command makes itself is substituted.
 *  - `review-accept-readtools.ts` — the read-tool KIND split: a content reader's operand
 *    decides, a search tool's pattern does not, a print tool never does.
 *  - `review-accept-scope.ts` — `inScope` returns the CLAUSE that fired, and the
 *    command-wide "any read tool + `$`" arm of test (5) is gone.
 *  - `review-accept-arms.ts` — A1 steps over the repo selectors to reach the verb, and
 *    the predicate that asked the command-wide read-tool question is REMOVED: a module
 *    that still exports it is a second answer to a question the guard no longer asks.
 */
import * as arms from "../src/review-accept-arms.ts";
import { namesShell } from "../src/review-accept-arms.ts";
import {
  armsOf,
  closingQuote,
  normalise,
  shellWords,
  skipHeredoc,
  unquote,
} from "../src/review-accept-command.ts";
import { reviewAcceptVerdict } from "../src/review-accept-guard.ts";
import { READ_TOOLS, readToolCarriesUnresolvedOperand } from "../src/review-accept-readtools.ts";
import { inScope } from "../src/review-accept-scope.ts";
import { gitVerbIndex } from "../src/review-accept-verb.ts";
import {
  storeNameSubject,
  withSameCommandAssignmentsApplied,
  withoutHeredocBodies,
} from "../src/review-accept-views.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const NL = String.fromCharCode(10);
const D = String.fromCharCode(36);

// ── the heredoc delimiter, quoted ───────────────────────────────────────────────
const quoted = `cat > /tmp/f <<'EOF'${NL}body line${NL}EOF`;
assert(
  normalise(quoted).ok === true,
  "command: a QUOTED heredoc delimiter parses instead of reporting PARSE_FAIL",
);
assert(
  normalise(`cat > /tmp/f <<${D}'EOF'${NL}body${NL}EOF`).ok === false,
  "command: a delimiter that never closes still reports itself unreadable",
);
const skip = (text: string, at: number) => {
  const past = skipHeredoc(text, at);
  return past === "PARSE_FAIL" ? undefined : past;
};
assert(
  skip(`cat <<-"TAG" a${NL}b${NL}\tTAG`, 4)?.end === 21,
  "command: <<- with a quoted tag skips to the end of the body",
);
assert(
  skip(`cat <<'EOF'${NL}body${NL}EOF | sh`, 4)?.tail === "| sh",
  "command: the words after a closing tag are the DELIMITER LINE's tail, not a body line",
);

// ── an escaped quote inside double quotes is not the end of the word ─────────────
const jq = 'gh pr view 1 --json title --jq ".title + \\"|\\" + .body"';
assert(
  closingQuote(jq, jq.indexOf('"')) === jq.length - 1,
  "command: the span closes at the LAST quote",
);
assert(
  shellWords(jq).length === 8,
  `command: the quoted pipe is inside one word (got ${shellWords(jq).length} words)`,
);

// ── the three text views ─────────────────────────────────────────────────────────
assert(
  !withoutHeredocBodies(`cat <<'EOF'${NL}rm -rf ${D}{a,b}${NL}EOF`).includes("a,b"),
  "views: a QUOTED-tag heredoc body is data, out of the expansion test's subject",
);
assert(
  withoutHeredocBodies(`cat <<EOF${NL}rm -rf ${D}{a,b}${NL}EOF`).includes("a,b"),
  "views: an UNQUOTED body is shell-expanded into the arguments, so it stays in the subject",
);
assert(
  withoutHeredocBodies(`cat <<'EOF'${NL}${D}x${NL}EOF | sh`).includes("| sh"),
  "views: the words after a closing tag stay visible even when the body is set aside",
);
assert(
  storeNameSubject(`git commit -m "the review-findings.json schema"`).includes("git commit"),
  "views: the prose value is masked but the command is still there to match",
);
assert(
  !storeNameSubject(`git commit -m "the review-findings.json schema"`).includes("review-findings"),
  "views: a literal --message value is not part of the name test's subject",
);
assert(
  storeNameSubject(`cat <<EOF${NL}review-findings.json${NL}EOF`).includes("review-findings"),
  "views: a heredoc BODY stays inside the name test's subject",
);
assert(
  storeNameSubject(`git commit -m "adds ${D}HOME" .git/review-findings.json`).includes(
    "review-findings",
  ),
  "views: an expansion in a prose value, or a path operand, is no mask at all",
);
assert(
  withSameCommandAssignmentsApplied(`F=.git/review-findings.json; cat > ${D}F`).includes(
    ".git/review-findings.json",
  ),
  "views: an expansion the command assigned is resolved for the name test",
);
assert(
  withSameCommandAssignmentsApplied(`cat ${D}UNSET`).includes(`cat ${D}UNSET`),
  "views: an expansion the command never assigned is left exactly as written",
);

// ── the read-tool kind split ─────────────────────────────────────────────────────
assert(
  !readToolCarriesUnresolvedOperand(`echo "FMT_EXIT=${D}?"`),
  "readtools: a PRINT tool's expansion brings nothing into scope",
);
assert(
  !readToolCarriesUnresolvedOperand(`cd ${D}WT && pwd && true`),
  "readtools: a NAVIGATE tool's expansion brings nothing into scope",
);
assert(
  readToolCarriesUnresolvedOperand(`ls -la ${D}PWD`),
  "readtools: `ls` is a file-stat tool, not a print tool — its operand is read (#1764)",
);
assert(
  readToolCarriesUnresolvedOperand(`wc -l ${D}F`),
  "readtools: `wc` counts the bytes of an unresolved operand — the same read as `cat`",
);
assert(
  readToolCarriesUnresolvedOperand(`echo x > ${D}F`),
  "readtools: a PRINT tool that REDIRECTS to an unresolved target is in scope — the redirect test runs on every program",
);
assert(
  readToolCarriesUnresolvedOperand(`grep --include=${D}F -r x .`),
  "readtools: a flag-attached value is an operand the program opens",
);
assert(
  readToolCarriesUnresolvedOperand(`grep -e "" ${D}F`),
  "readtools: with an explicit -e, the positional is a FILE, not the pattern",
);
assert(
  readToolCarriesUnresolvedOperand(`grep -f ${D}P notes.txt`),
  "readtools: the value of -f is itself a path",
);
assert(
  readToolCarriesUnresolvedOperand(`grep -e pat -- ${D}F`),
  "readtools: `--` ends the OPTIONS, not the operands",
);
assert(
  !readToolCarriesUnresolvedOperand(`cat <<'EOF'${NL}${D}x${NL}EOF`),
  "readtools: a QUOTED-tag heredoc body never reaches the guard's store bytes",
);
assert(
  !readToolCarriesUnresolvedOperand(`grep -n 'a${D}' src/x.ts`),
  "readtools: a search PATTERN is prose, not a file operand",
);
assert(
  readToolCarriesUnresolvedOperand(`cat ${D}F`),
  "readtools: a content reader on an unresolved operand is the guard's business",
);
assert(
  !readToolCarriesUnresolvedOperand(`f=notes.md; cat ${D}f`),
  "readtools: an operand the command resolved itself is a readable read",
);
assert(
  readToolCarriesUnresolvedOperand(`grep -rn pattern ${D}SRC`),
  "readtools: a search tool's FILE operand counts even when its pattern does not",
);
assert(
  !readToolCarriesUnresolvedOperand(`cat > /tmp/f <<'PY'\nprint(${D}x)\nPY\n`),
  "readtools: a heredoc BODY is never an argument — the body lines are not this command's operands",
);
assert(
  readToolCarriesUnresolvedOperand(`cat <<'PY' > ${D}F\nhello\nPY\n`),
  "readtools: the words after the opening tag on its own line are still arguments (#1764 criterion 5)",
);
assert(
  !readToolCarriesUnresolvedOperand(`cat > /tmp/f <<'PY' import os, subprocess print("$@") PY`),
  "readtools: a flattened harvested body is never an operand list — the guard stops at the operator",
);
assert(
  READ_TOOLS.has("cat") && READ_TOOLS.has("grep") && READ_TOOLS.has("echo"),
  "readtools: READ_TOOLS is the union of the three kinds the scope test separates",
);

// ── the clause identity ──────────────────────────────────────────────────────────
const clauseOf = (command: string) => {
  const kept = command.toLowerCase();
  const parsed = normalise(command);
  return inScope(
    kept,
    parsed.ok ? parsed.text : kept.replace(/\s+/g, " ").trim(),
    shellWords(kept),
  );
};
assert(
  clauseOf(`cat .git/review-findings.json`) === "store-name",
  "scope: the name test is clause 1",
);
assert(
  // The one shape clause (2) owns: a value GLUED to a pickaxe flag is a single token, so
  // clause (1)'s basename test never sees the name and only the attached-value read does.
  clauseOf("git log -Greview-findings-store") === "attached-value",
  "scope: a store name attached to an option is clause 2, and says so",
);
assert(
  clauseOf("git --git-dir=/repo/.git status") === "repo-selector",
  "scope: a selector is clause 3",
);
assert(
  clauseOf(`bun - <<EOF${NL}import`) === "executing-operand",
  "scope: a heredoc into a runtime is clause 4",
);
assert(
  clauseOf(`cat ${D}F`) === "unreadable-word",
  "scope: an unreadable file operand is clause 5",
);
assert(
  clauseOf("git show HEAD:blob --output=/tmp/x") === "write-argument",
  "scope: a write-capable argument is clause 6",
);
assert(clauseOf("echo FMT_EXIT=$?") === undefined, "scope: an ordinary echo is no clause at all");
assert(
  clauseOf("cd extension && echo $PWD") === undefined,
  "scope: a chained print is no clause at all",
);

// ── A1 reaches the verb past the repo selectors, and only past RESOLVED ones ──────
const wt = "/home/ops/orchard/work/orchard";
assert(
  arms.armGitRead(shellWords(`git -C ${wt} log --oneline -5`)) === true,
  "arms: A1 asks the VERB after a resolved repo-location selector",
);
assert(
  arms.armGitRead(shellWords(`git -C ${wt} status --porcelain`)) === true,
  "arms: the status spelling reaches the same read verb",
);
assert(
  arms.armGitRead(shellWords(`git --no-pager -C ${wt} diff HEAD`)) === true,
  "arms: a --no-pager before the selector is stepped over too",
);
assert(
  arms.armGitRead(shellWords("git -C /repo/.git log")) === false,
  "arms: a selector AT the repo location is still refused — stepping is not clearing",
);
assert(
  arms.armGitRead(shellWords(`git -C ${D}WT log`)) === false,
  "arms: an unresolved selector is still refused before the verb is ever asked",
);
assert(
  arms.armForgeRead(
    shellWords('gh pr view 1 --json title,body --jq ".title + \\"|\\" + .body"'),
  ) === true,
  "arms: A2 keeps a quoted filter with a pipe inside it — the word is one word",
);

// ── the predicate the narrowing left without a caller is GONE ────────────────────
assert(
  !("namesReadTool" in arms),
  "arms: the command-wide read-tool predicate clause (5) used is removed, not shelved",
);

// ── the one git-verb reader, and the shells clause (4) must reach ───────────────
assert(
  gitVerbIndex(shellWords(`git -C ${wt} commit -m "x"`)) === 3,
  "verb: ONE reader finds the verb past the selectors — the mask and the arms cannot disagree",
);
assert(
  gitVerbIndex(shellWords("git status")) === 1,
  "verb: the plain spelling is the same function",
);
assert(
  gitVerbIndex(shellWords("echo git rm -r .")) === -1,
  "verb: prose in the middle of a line names no verb",
);
const shellHeredoc = `cat <<EOF${NL}echo ${D}x${NL}EOF | sh`;
assert(
  inScope(shellHeredoc, `cat <<EOF echo ${D}x EOF | sh`, shellWords(shellHeredoc)) ===
    "executing-operand",
  "scope: a heredoc feeding a SHELL is clause 4 — bash is no more a read tool than bun",
);
const shellPlain = `env sh -c 'echo hi'`;
assert(
  inScope(shellPlain, "env sh -c echo hi", shellWords(shellPlain)) === undefined,
  "scope: a shell with no heredoc and no stdin dash is not in scope by itself",
);
assert(
  namesShell("exec sh"),
  "arms: a shell is an EXECUTING program whether it is the head or not",
);

// ── the assignment resolver: order, ambiguity, quoting ─────────────────────────
assert(
  !withSameCommandAssignmentsApplied(`cat ${D}F; F=notes.txt`).includes("cat notes.txt"),
  "views: a binding AFTER the word that uses it resolves nothing — a later segment is a later statement",
);
assert(
  !withSameCommandAssignmentsApplied(`F=.git/review-findings.json; F=x; cat ${D}F`).includes(
    "cat x",
  ),
  "views: a name bound twice with different values is left unresolved, not guessed at",
);
assert(
  withSameCommandAssignmentsApplied(`F=x; F=x; cat ${D}F`).includes("cat x"),
  "views: the same value bound twice is not an ambiguity",
);
assert(
  !withSameCommandAssignmentsApplied(`echo 'F=x'; cat ${D}F`).includes("cat x"),
  "views: a single-quoted assignment binds nothing — the shell never parsed it as one",
);
assert(
  withSameCommandAssignmentsApplied(`export F=notes.md; cat ${D}F`).includes("cat notes.md"),
  "views: an exported literal still resolves",
);

// ── the unquote the three views share ───────────────────────────────────────────
const BS = String.fromCharCode(92);
assert(
  unquote(`'a${BS}nb'`) === `a${BS}nb`,
  "command: inside single quotes a backslash is LITERAL — erasing it manufactured store names",
);
assert(unquote(`"a${BS}"b"`) === 'a"b', "command: inside double quotes an escaped quote collapses");

// ── the scanners terminate on the characters they do not consume ─────────────────
//
// A word scan that meets `(`, `)`, `<` or `>` and makes no progress on it loops forever,
// and this guard runs SYNCHRONOUSLY inside every agent's bash tool call — a loop there is
// not a slow test, it is a wedged cycle (the shape that killed the previous round of this
// issue mid-suite). Each string below is a shape whose characters the scanners refuse to
// eat; the assertion is that a verdict arrives, and arrives in milliseconds, not that the
// verdict has any particular polarity.
const PATHOLOGICAL = [
  "( x )",
  "a=<f",
  "F=x; (cat $F)",
  "cat <$F",
  "))(<<>><<",
  "echo >(tee out)",
  "a> >b",
  "<<EOF",
  "<<'EOF'",
  "a <<< b",
  "$((1+2))",
  "`", //
  "''''",
  '""""',
  "cat << << << EOF",
  // The round-3 scanners' own edges: a here-string that runs off the end, and an fd
  // duplication left dangling — the two shapes the `&` and `<<<` handling introduced.
  "cat <<<",
  "cat <<<<",
  "cat x >&",
  "cat x 2>&",
  "cat x <&",
  "cat x &>>",
];
const perCase: Array<[string, number]> = [];
let verdicts = 0;
const allStarted = Date.now();
for (const c of PATHOLOGICAL) {
  const started = Date.now();
  const kept = c.toLowerCase();
  const parsed = normalise(c);
  inScope(kept, parsed.ok ? parsed.text : kept.replace(/\s+/g, " ").trim(), shellWords(kept));
  readToolCarriesUnresolvedOperand(kept);
  armsOf(kept);
  shellWords(kept);
  perCase.push([c, Date.now() - started]);
  verdicts++;
}
const elapsed = Date.now() - allStarted;
// PER CASE, not one span over the whole list: a single budget lets one pathological input
// burn 4.9s and a genuine hang in another still read as green, and the number a reviewer
// can act on is the one that names the command. Nothing here should take measurable time —
// 250ms over 12 shapes is two orders of magnitude above what they cost.
const slowest = perCase.reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0] as [string, number]);
assert(
  verdicts === PATHOLOGICAL.length && elapsed < 250,
  `command: every scanner returns on a character it does not consume (${verdicts}/${PATHOLOGICAL.length} verdicts, ${elapsed}ms total, slowest ${slowest[1]}ms ${JSON.stringify(slowest[0])})`,
);
for (const [c, ms] of perCase) {
  assert(ms < 100, `command: one pathological shape costs no measurable time (${ms}ms) — ${JSON.stringify(c)}`);
}
// The four shapes the fix brief names, with the polarity each one is supposed to have.
assert(
  reviewAcceptVerdict("cat <$F") !== undefined,
  "guard: `cat <$F` reads through an unreadable redirect — refused, not hung",
);
assert(
  reviewAcceptVerdict("( x )") === undefined,
  "guard: a subshell that names nothing is an ordinary command",
);
assert(
  reviewAcceptVerdict("a=<f") === undefined,
  "guard: `<` as an assignment value is data, not a redirect the guard must chase",
);
assert(
  reviewAcceptVerdict("F=x; (cat $F)") === undefined,
  "guard: a binding EARLIER in the same command resolves a SUBSHELL's read — the shell exports it",
);
assert(
  reviewAcceptVerdict("(cat $F)") !== undefined,
  "guard: leading group punctuation does not hide the read tool behind it",
);
assert(
  reviewAcceptVerdict("sudo cat $F") !== undefined,
  "guard: a prefix word does not hide the read tool behind it either",
);

process.exit(exit);
