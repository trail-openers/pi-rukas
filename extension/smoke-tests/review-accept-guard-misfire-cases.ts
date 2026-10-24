/**
 * Case tables for #1665 / #1643 / #1578 — the guard misfires measured on a live host,
 * and the store-reaching shapes that must stay refused beside them.
 *
 * Kept in its own module (the #1125 sibling `review-accept-guard-cases.ts` is at the
 * §12 size cap). These are DATA only; the polarity is the suite's.
 *
 * The shape of the rule these tables encode (#1643 Decision 1, resolved-target):
 * a command is the guard's business only when it REFERENCES the findings store or runs
 * the operator's accept script. `-C <path>` and friends are repo-location SELECTORS, so
 * they are asked where they point — a worktree is an ordinary path, the store's own
 * directory is not.
 */

import type { Case } from "./review-accept-guard-cases.ts";

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const Q = String.fromCharCode(39);
const D = String.fromCharCode(36); // a dollar sign, spelled so the table is data
const DATA = "review-findings.json";
const STORE = "review-findings-store";
/** A worktree / checkout path — an ordinary directory the guard has no business with. */
const TREE = "/home/ops/app/work/app";

/**
 * The commands a plan cycle was REFUSED today and must never be refused again. Every one
 * of them spells no protected name and points no selector at the store's directory.
 * If a row here goes red, the guard is back to bricking the sanctioned
 * `git -C <worktree>` form AGENTS.md mandates (#1643), or back to refusing prose that
 * merely carries a backslash (#1665).
 */
export const MEASURED_MISFIRES_ALLOWED: Case[] = [
  { c: `git -C ${TREE} status --porcelain`, why: "the status of a worktree" },
  { c: `git -C ${TREE} fetch origin main`, why: "fetching into a worktree" },
  { c: `git -C ${TREE} diff --stat`, why: "the diff of a worktree" },
  { c: `git -C ${TREE} log --oneline -5 origin/main`, why: "the log of a worktree" },
  { c: `git -C ${TREE} show HEAD:README.md`, why: "a blob read from a worktree" },
  { c: `git -C ${TREE} blame src/a.ts`, why: "blame in a worktree" },
  { c: `git -C ${TREE} add -A`, why: "staging a worktree's diff" },
  { c: `git -C ${TREE} commit -m "fix: a thing"`, why: "committing in a worktree" },
  { c: "git -C . status", why: "the same-directory spelling" },
  { c: "git -C extension status --porcelain", why: "a relative worktree path" },
  { c: `git -C ${TREE} rev-parse --abbrev-ref HEAD`, why: "the branch of a worktree" },
  // A heredoc that writes an ordinary scratch file: the body is prose, the target is
  // nobody's findings store (#1665's `cat > f <<EOF`, #1643's `-F-` heredoc).
  { c: `cat > /tmp/f <<EOF${NL}hello${NL}EOF`, why: "a heredoc into an ordinary file" },
  {
    c: `cat > tmp/issue-1665/body.md <<EOF${NL}# Title${NL}- a bullet${NL}EOF`,
    why: "a scratch body file",
  },
  {
    c: `git commit -F- <<EOF${NL}fix(guards): the message${NL}EOF`,
    why: "a commit message by heredoc",
  },
  {
    c: `cat <<EOF${NL}a line with a backslash \\ in it${NL}EOF`,
    why: "a heredoc body carrying a backslash",
  },
  { c: `cat <<'SH'${NL}git status${NL}SH`, why: "a quoted heredoc that runs nothing" },
  // An unparseable command that is nowhere near the store. #1738: the parse failure is
  // not itself a refusal — the SAME scope predicate a readable command faces decides,
  // and none of its six tests fires here.
  {
    c: `echo ${Q}a line of prose about a normal file`,
    why: "a stray quote in prose that names no store",
  },
  {
    c: `git status --porcelain <<EOF${NL}some body text`,
    why: "an unterminated heredoc beside a read verb that executes and writes nothing",
  },
  // The selector test is PER SEGMENT (#1738), the unit the arms judge: a `-c` in a
  // segment that runs no git is some other program's flag, not a repo selector.
  { c: "git log --oneline && ls -c", why: "a short flag in the segment that runs no git" },
  { c: `printf hello \\${NL}world`, why: "a line continuation in an ordinary command" },
  // The pair to the write-verb refusals below: `hash-object` writes only with `-w`, so
  // reading an object from a heredoc stays the ordinary command it is.
  {
    c: `git hash-object --stdin <<EOF${NL}payload${NL}EOF`,
    why: "git hash-object READING, with no -w",
  },
  // Backslash-bearing ARGUMENTS: the shell removes the backslash, and what is left names
  // no store (#1665's `echo -e`, `printf`, `grep`/`rg` BRE alternation, `gh --jq`).
  { c: `printf ${Q}hello\\n${Q} > /tmp/f`, why: "printf with an escaped newline" },
  { c: `echo -e ${Q}a\\nb${Q}`, why: "echo -e with an escaped newline" },
  {
    c: `grep -n ${Q}VERSION\\|_SHA256\\|ARG\\|FROM${Q} host/sandbox/build.sh`,
    why: "a grep BRE alternation",
  },
  {
    c: `rg -n --no-heading ${Q}state/cycles|cycles/|\\.done|\\.park|park-${Q} libexec/cycle`,
    why: "an rg pattern carrying escaped dots and pipes",
  },
  {
    c: `grep -n ${Q}pattern${Q} .git/info/exclude`,
    why: "a grep of a git-internal file that is not the findings store",
  },
  { c: "head -20 .git/config", why: "a read of another git-internal file" },
  {
    c: `gh issue view 1665 --json title,body --jq ${Q}.title + "\\n" + .body${Q}`,
    why: "a gh read whose --jq filter carries an escaped newline",
  },
  {
    c: "gh api -X PUT repos/o/r/branches/main/protection --input file.json",
    why: "a gh api write to no store path",
  },
  {
    c: `awk ${Q}BEGIN{system("echo ${D}{HOME}")}${Q}`,
    why: "awk running a shell at no store path",
  },
  // A LEADING `~` is HOME, which is nobody's findings store (#1738: refusing it re-created
  // #1643's misfire on the worktree form). `~user` and a `~` anywhere else in the target stay
  // refused — see STORE_REACHING_REFUSALS.
  { c: "git -C ~/work/wt status", why: "the sanctioned worktree form, home-relative" },
  {
    c: "git -C ~/my-app/work/my-app log --oneline -5 origin/main",
    why: "a home-relative worktree log",
  },
  // The git WRITE VERB is a POSITION — the bare word after the segment's leading `git` — so
  // prose that merely mentions one is not a program putting bytes on disk. Each row below is
  // a command the word-anywhere test used to refuse.
  {
    c: `git commit -m ${Q}apply${Q} <<EOF${NL}the message is one word`,
    why: "the word apply as a whole commit message beside an unterminated heredoc",
  },
  {
    c: `git status --porcelain <<EOF${NL}rm the old notes`,
    why: "the word rm inside an unterminated heredoc body beside a read verb",
  },
  {
    c: `cat > /tmp/notes.md <<EOF${NL}run git rm build before deploying${NL}EOF`,
    why: "a heredoc body whose prose mentions git rm mid-sentence",
  },
];

/**
 * The same shapes WITH the store in their sight line — the pair that makes the table
 * above a scope test rather than a weakening. Each reaches the findings store's bytes or
 * runs the operator's accept script, and stays refused.
 */
export const STORE_REACHING_REFUSALS: Case[] = [
  // A repo-location selector pointing AT the store's directory (the git common dir, where
  // review-findings.json lives) makes every "plain read" a read of the store's tree.
  { c: "git -C /repo/.git status --porcelain", why: "ACCEPTANCE: -C at the store's directory" },
  { c: "git -C .git status --porcelain", why: "-C at the store's directory, relative" },
  { c: "git -C /repo/.git log --oneline", why: "-C at the store's directory beside a log" },
  { c: "git -C /repo/.git/review-findings.json log", why: "-C at the data file itself" },
  { c: "git -C ${$HOME}/.git status", why: "-C at an expansion into the store's directory" },
  { c: "git --git-dir=/repo/.git status", why: "ACCEPTANCE: --git-dir at the store's directory" },
  { c: "git --git-dir /repo/.git status", why: "--git-dir with a spaced value" },
  { c: "git --GIT-DIR=/repo/.git status", why: "--git-dir in its original case" },
  { c: "git --work-tree=/repo/.git status", why: "--work-tree at the store's directory" },
  { c: "git --exec-path=/repo/.git status", why: "--exec-path at the store's directory" },
  // The selectors that are NEVER cleared by their target, whatever they point at: a
  // `-c key=value` is a config the program then RUNS (a pager, a hook path, an alias),
  // and `--git-dir` / `--work-tree` / `--exec-path` move the object store or the git
  // program itself. Clause (b)'s accepted cost, kept deliberately — only `-C <path>`, the
  // form AGENTS.md mandates, is resolved.
  {
    c: "git -c core.pager=cat log --oneline",
    why: "ACCEPTANCE: a config override the program runs",
  },
  { c: "git -c color.ui=never diff HEAD~1 HEAD", why: "a config override on a diff" },
  { c: "git -c core.fsmonitor=/tmp/probe status", why: "a config whose value is a program path" },
  { c: "git --exec-path=/usr/lib/git-core status", why: "--exec-path names the program directory" },
  { c: "git --git-dir=/srv/other/log status", why: "--git-dir moves the object store" },
  { c: "git --work-tree=/srv/other status", why: "--work-tree moves the work tree" },
  { c: `git -C /repo/.git add ${DATA}`, why: "a selector at the store beside a store operand" },
  {
    c: `git -C ${TREE} status && cat ${DATA}`,
    why: "ACCEPTANCE: a worktree selector chained to a read of the data file",
  },
  {
    c: `git -C ${TREE} log -G${STORE}`,
    why: "ACCEPTANCE: a worktree selector beside a pickaxe on the store module",
  },
  // A path that reaches the store by walking, not by spelling.
  { c: `cat .git/../.git/${DATA}`, why: "a ..-walk onto the data file" },
  { c: `cat ${Q}.git/${DATA}${Q}`, why: "the data file quoted" },
  // Backslash-escaped spellings of the store's name: the shell removes the backslash and
  // hands the program the exact store name, so the erased view must catch it.
  { c: "cat re\\view-findings.json", why: "ACCEPTANCE: a backslash inside the data name" },
  { c: "cat rev\\iew-findings.js\\on", why: "backslashes in both halves of the data name" },
  { c: "cat /repo/.git/review\\-findings.json", why: "an escaped hyphen in the data name" },
  {
    c: `grep -n ${Q}x${Q} re\\view-findings.json`,
    why: "ACCEPTANCE: a grep pattern that is harmless, against an escaped store path",
  },
  { c: `rg --no-heading ${Q}a\\|b${Q} ${DATA}`, why: "a harmless rg pattern beside the data file" },
  // Redirections and heredocs whose TARGET is the store.
  { c: `cat > .git/${DATA} <<EOF${NL}{"rows":[]}${NL}EOF`, why: "a heredoc writing the data file" },
  { c: `printf ${Q}x${Q} > .git/${DATA}`, why: "a printf redirecting into the data file" },
  { c: `echo -e ${Q}a\\nb${Q} > .git/${DATA}`, why: "echo -e redirecting into the data file" },
  { c: `cat other.txt > /repo/.git/${DATA}`, why: "a redirect into the data file" },
  {
    c: `cat > /tmp/f <<EOF${NL}import "./src/${STORE}.ts"${NL}EOF`,
    why: "a heredoc body that names the store module",
  },
  {
    c: `cat > /tmp/f <<EOF${NL}${Q}rev${Q}${Q}iew-findings.json${Q}${NL}EOF`,
    why: "a heredoc body assembling the data name",
  },
  // The operator's accept script, by name and by path.
  {
    c: "bun extension/scripts/review-accept.ts feat/x deadbeef --reason x",
    why: "running the accept CLI",
  },
  { c: `bun ${Q}extension/scripts/review-accept.ts${Q}`, why: "the accept CLI quoted" },
  {
    c: `cat > /tmp/f <<EOF${NL}bun extension/scripts/review-accept.ts a b${NL}EOF`,
    why: "a heredoc body that runs the accept script",
  },
  // The store's name split across a LINE CONTINUATION: the shell deletes `\` + newline
  // and hands the program one word, so the erased view must join the halves before it
  // tokenises (#1738 — keeping the newline left two words that named nothing).
  {
    c: `cat .git/review\\${NL}-findings.json`,
    why: "ACCEPTANCE: the data name split by a line continuation",
  },
  {
    c: `cat .git/review\\${CR}${NL}-findings.json`,
    why: "the data name split by a CRLF continuation",
  },
  // UNPARSEABLE and in scope: the parse failure is not what refuses, the scope test is.
  // Each row below reaches the store by a route other than the bare name, so the
  // unreadable branch that used to consult the name test alone let it through.
  {
    c: `git -c core.fsmonitor=/tmp/probe log --oneline ${Q}x`,
    why: "ACCEPTANCE: an uncleared selector inside an unparseable command",
  },
  {
    c: `git apply <<EOF${NL}--- a/x`,
    why: "ACCEPTANCE: an unterminated heredoc beside a git verb that writes",
  },
  { c: `bun - <<EOF${NL}import`, why: "an unterminated heredoc feeding a runtime" },
  // A heredoc or a stdin `-` beside a git verb that WRITES from it. Clause (a)'s
  // unreadable text next to a program that puts bytes on disk.
  {
    c: `git apply <<EOF${NL}--- a/x${NL}+++ b/x${NL}EOF`,
    why: "ACCEPTANCE: a patch handed to git apply by heredoc",
  },
  { c: "echo patch | git apply -", why: "a patch piped into git apply on stdin" },
  { c: `git am - <<EOF${NL}From: x`, why: "a mailbox handed to git am" },
  {
    c: `git update-index --add - <<EOF${NL}a.txt${NL}EOF`,
    why: "paths handed to git update-index on stdin",
  },
  { c: `git mv a b <<EOF${NL}junk${NL}EOF`, why: "a heredoc beside git mv" },
  { c: `git rm --cached - <<EOF${NL}a.txt${NL}EOF`, why: "paths handed to git rm on stdin" },
  {
    c: `git checkout-index -a -f <<EOF${NL}junk${NL}EOF`,
    why: "a heredoc beside git checkout-index",
  },
  {
    c: `git hash-object -w --stdin <<EOF${NL}payload${NL}EOF`,
    why: "ACCEPTANCE: git hash-object WRITING the object it reads",
  },
  // The attached selector that used to swallow the word after it: the value is inside
  // the flag, so nothing was consumed and the following `-c` was never read (#1738).
  {
    c: "git log --oneline -C/tmp/x -c core.fsmonitor=/tmp/probe",
    why: "ACCEPTANCE: a config selector the attached selector used to hide",
  },
  {
    c: "git diff HEAD --stat -C=/tmp/x -c core.pager=cat",
    why: "an `=`-attached selector hiding the selector after it",
  },
  { c: "git -C/repo/.git log --oneline", why: "an attached selector at the store's directory" },
  // A selector the guard matches but cannot resolve, so it cannot clear it either.
  { c: "git -C .git/* status", why: "ACCEPTANCE: a globbed selector at the store's directory" },
  { c: "git -C repo/../.git status", why: "a `..`-walk in a selector's target" },
  { c: "git -C ~/repo/.git status", why: "a home-relative selector at the store's directory" },
  // The selector test is per SEGMENT, so a chained git segment cannot borrow the first
  // segment's cleared selector.
  {
    c: `git -C ${TREE} status && git -c core.fsmonitor=/tmp/probe log`,
    why: "ACCEPTANCE: a second segment carrying an uncleared selector",
  },
  // A SPACED selector whose next word is ANOTHER option took that word as its value and
  // consumed it, hiding the selector behind it (#1738). It is unresolved and unconsumed now.
  {
    c: "git -C -c core.pager=cat log",
    why: "ACCEPTANCE: a spaced selector whose value is another option, hiding a config",
  },
  // The selector and write-flag tests are also asked of the BACKSLASH-ERASED word: the shell
  // removes the escape before the program reads it, so `-\c` is `-c` by then (#1738).
  {
    c: "git -C /tmp/wt -\\c core.pager=x log",
    why: "ACCEPTANCE: an escaped config selector behind a spaced worktree selector",
  },
  {
    c: `git show HEAD:blob -\\o ${DATA}`,
    why: "an escaped output flag beside the data file",
  },
  // A `~` is only an ordinary path at the HEAD of the target, where it is HOME. `~user`
  // expands outside this user's home and a `~` elsewhere is a path the guard cannot resolve.
  { c: "git -C ~otheruser/app status", why: "ACCEPTANCE: a `~user` selector" },
  { c: "git -C app/~otheruser status", why: "a `~` away from the head of the target" },
  // The write verb is a POSITION asked of the words as the shell hands them over, so a quoted
  // verb counts, and one `hash-object` decoy cannot answer for a write verb beside it (#1738).
  {
    c: `git ${Q}apply${Q} <<EOF${NL}--- a/x${NL}+++ b/x${NL}EOF`,
    why: "ACCEPTANCE: a QUOTED git write verb — the shell hands git `apply` as its verb",
  },
  {
    c: `git hash-object --stdin && git apply <<EOF${NL}--- a/x${NL}EOF`,
    why: "ACCEPTANCE: a hash-object decoy beside a git write verb",
  },
];
