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
const Q = String.fromCharCode(39);
const D = String.fromCharCode(36); // a dollar sign, spelled so the table is data
const DATA = "review-findings.json";
const STORE = "review-findings-store";
/** A worktree / checkout path — an ordinary directory the guard has no business with. */
const TREE = "/home/boss/tehas/work/tehas";

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
  { c: `git -C . status`, why: "the same-directory spelling" },
  { c: "git -C extension status --porcelain", why: "a relative worktree path" },
  { c: `git -C ${TREE} rev-parse --abbrev-ref HEAD`, why: "the branch of a worktree" },
  // A heredoc that writes an ordinary scratch file: the body is prose, the target is
  // nobody's findings store (#1665's `cat > f <<EOF`, #1643's `-F-` heredoc).
  { c: `cat > /tmp/f <<EOF${NL}hello${NL}EOF`, why: "a heredoc into an ordinary file" },
  { c: `cat > tmp/issue-1665/body.md <<EOF${NL}# Title${NL}- a bullet${NL}EOF`, why: "a scratch body file" },
  { c: `git commit -F- <<EOF${NL}fix(guards): the message${NL}EOF`, why: "a commit message by heredoc" },
  { c: `cat <<EOF${NL}a line with a backslash \\ in it${NL}EOF`, why: "a heredoc body carrying a backslash" },
  { c: `cat <<'SH'${NL}git status${NL}SH`, why: "a quoted heredoc that runs nothing" },
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
  { c: `gh api -X PUT repos/o/r/branches/main/protection --input file.json`, why: "a gh api write to no store path" },
  { c: `awk ${Q}BEGIN{system("echo ${D}{HOME}")}${Q}`, why: "awk running a shell at no store path" },
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
  { c: "git -c core.pager=cat log --oneline", why: "ACCEPTANCE: a config override the program runs" },
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
  { c: `cat re\\view-findings.json`, why: "ACCEPTANCE: a backslash inside the data name" },
  { c: `cat rev\\iew-findings.js\\on`, why: "backslashes in both halves of the data name" },
  { c: `cat /repo/.git/review\\-findings.json`, why: "an escaped hyphen in the data name" },
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
  { c: "bun extension/scripts/review-accept.ts feat/x deadbeef --reason x", why: "running the accept CLI" },
  { c: `bun ${Q}extension/scripts/review-accept.ts${Q}`, why: "the accept CLI quoted" },
  {
    c: `cat > /tmp/f <<EOF${NL}bun extension/scripts/review-accept.ts a b${NL}EOF`,
    why: "a heredoc body that runs the accept script",
  },
];
