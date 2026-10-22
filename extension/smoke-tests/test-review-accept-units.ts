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
import {
  closingQuote,
  normalise,
  shellWords,
  skipHeredoc,
} from "../src/review-accept-command.ts";
import { inScope } from "../src/review-accept-scope.ts";
import {
  READ_TOOLS,
  readToolCarriesUnresolvedOperand,
} from "../src/review-accept-readtools.ts";
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
assert(
  skipHeredoc(`cat <<-"TAG" a${NL}b${NL}\tTAG`, 4) === 21,
  "command: <<- with a quoted tag skips to the end of the body",
);

// ── an escaped quote inside double quotes is not the end of the word ─────────────
const jq = 'gh pr view 1 --json title --jq ".title + \\"|\\" + .body"';
assert(closingQuote(jq, jq.indexOf('"')) === jq.length - 1, "command: the span closes at the LAST quote");
assert(
  shellWords(jq).length === 8,
  `command: the quoted pipe is inside one word (got ${shellWords(jq).length} words)`,
);

// ── the three text views ─────────────────────────────────────────────────────────
assert(
  !withoutHeredocBodies(`cat <<EOF${NL}rm -rf ${D}{a,b}${NL}EOF`).includes("a,b"),
  "views: the expansion test's subject has no heredoc body in it",
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
  !readToolCarriesUnresolvedOperand(`cd ${D}WT && pwd && ls -la ${D}PWD`),
  "readtools: NAVIGATE and LIST tools bring nothing into scope",
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
  !readToolCarriesUnresolvedOperand(`cat > /tmp/f <<'PY' print(${D}x) PY`),
  "readtools: a heredoc operator ends the operand list — a body is never an argument",
);
assert(
  READ_TOOLS.has("cat") && READ_TOOLS.has("grep") && READ_TOOLS.has("echo"),
  "readtools: READ_TOOLS is the union of the three kinds the scope test separates",
);

// ── the clause identity ──────────────────────────────────────────────────────────
const clauseOf = (command: string) => {
  const kept = command.toLowerCase();
  const parsed = normalise(command);
  return inScope(kept, parsed.ok ? parsed.text : kept.replace(/\s+/g, " ").trim(), shellWords(kept));
};
assert(clauseOf(`cat .git/review-findings.json`) === "store-name", "scope: the name test is clause 1");
assert(
  // The one shape clause (2) owns: a value GLUED to a pickaxe flag is a single token, so
  // clause (1)'s basename test never sees the name and only the attached-value read does.
  clauseOf("git log -Greview-findings-store") === "attached-value",
  "scope: a store name attached to an option is clause 2, and says so",
);
assert(clauseOf("git --git-dir=/repo/.git status") === "repo-selector", "scope: a selector is clause 3");
assert(clauseOf(`bun - <<EOF${NL}import`) === "executing-operand", "scope: a heredoc into a runtime is clause 4");
assert(clauseOf(`cat ${D}F`) === "unreadable-word", "scope: an unreadable file operand is clause 5");
assert(
  clauseOf("git show HEAD:blob --output=/tmp/x") === "write-argument",
  "scope: a write-capable argument is clause 6",
);
assert(clauseOf("echo FMT_EXIT=$?") === undefined, "scope: an ordinary echo is no clause at all");
assert(clauseOf("cd extension && echo $PWD") === undefined, "scope: a chained print is no clause at all");

// ── A1 reaches the verb past the repo selectors, and only past RESOLVED ones ──────
const wt = "/home/boss/tehas/work/tehas";
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

process.exit(exit);
