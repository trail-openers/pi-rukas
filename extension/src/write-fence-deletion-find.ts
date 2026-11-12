/**
 * write-fence-deletion-find — the `find` half of the deletion rule (#2200): which
 * paths a `find` removes, and which form cannot be judged at all.
 *
 * `-delete` removes the start paths it names, or its own directory when it named
 * none. `-exec` / `-execdir` / `-ok` / `-okdir` run their words once per MATCH, so
 * what they remove cannot be named before the match exists — the same fail-closed
 * shape as an unresolvable expansion, and precisely the form the #2200 incident's
 * prefix sweep used (`find <shared temp root> -name 'p*' -print0 | xargs -0 -r rm -rf`).
 *
 * What the rule can judge is decided by one question: does the line name the trees the
 * victims live under? It does for a literal-path `-delete`, for an `-exec rm` over literal
 * start paths, and for a `find <paths> … | xargs rm` whose matched names arrive on standard
 * input — all judged by the start paths, which is what lets a developer clean a build dir
 * with the tool they reach for while the same judgement refuses the incident's sweep over a
 * shared root. A name pattern narrows within those trees without hiding them, so it changes
 * nothing. An `-exec` of something that is not a remover deletes nothing, so the line names
 * no victim and is not a deletion at all; a `find` with no start path names no tree, and
 * that is the refusal rather than a guess on the directory it may not have run in.
 */

import type { Word } from "./write-fence-bash-lex.ts";
import {
  attachedPlaceholder,
  commandName,
  isRemover,
  removalOperands,
  stripPrefix,
  xargsPlaceholders,
} from "./write-fence-bash-split.ts";

/** The `find` actions that run their words as a command, once per match. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Why a `find -exec` names no tree at all: it gave no start path and its victims are matches. */
const UNNAMED_DIR_REASON =
  "its -exec removes from a directory the command does not name, so the target cannot be judged. Name the directory";

/** A refusal word: the rule cannot name what this `find` removes, with the reason why. */
function refusalWord(reason: string): Word {
  return { text: reason, refusal: reason, dyn: false };
}
const UNNAMED_DIR = refusalWord(UNNAMED_DIR_REASON);

/**
 * The words a `find` deletes, as it named them; empty when it removes nothing.
 * `pipedIntoRemover` says this `find`'s output is handed to a remover that names no
 * path (`find <paths> -print0 | xargs -0 -r rm -rf`) — the incident's own shape, where
 * the victims are the matches printed by this `find` and nothing else on the line names
 * them. They are therefore judged by the `find`'s OWN start paths: a sweep over a
 * shared temp root is refused by those paths, and a cleanup of the child's own tree is
 * allowed by the same rule. A name pattern narrows within those trees without hiding
 * them, so it changes nothing; what is refused is a `find` that names no tree at all.
 */
export function findRemovals(args: Word[], pipedIntoRemover = false): Word[] {
  const { starts, expr } = splitFind(args);
  const exec = expr.findIndex((a) => FIND_EXEC.has(a.text));
  if (exec >= 0) return execRemovals(starts, expr, pipedIntoRemover);
  if (!expr.some((a) => a.text === "-delete")) {
    // No removal action of its own: a `find` piped into a remover is the sweep.
    return pipedIntoRemover ? (starts.length > 0 ? starts : [{ text: ".", dyn: false }]) : [];
  }
  return starts.length > 0 ? starts : [{ text: ".", dyn: false }];
}

/**
 * Whether this simple command is a remover whose targets the command itself does not
 * name. Asked of the segment AS TYPED, so the `xargs` wrapper is still on it: through
 * xargs the words after the remover are the replacement placeholder (`xargs -I{} rm -rf
 * {}`, `xargs -i% rm -rf %`), which names a match rather than a path — so the line has
 * named no tree of its own and is judged by the producer's start paths. A remover that
 * carries any OTHER word (`xargs rm /tmp/victim`) named that path itself and is judged on
 * it; a remover with no operands at all (`xargs -0 -r rm -rf`, `ls | xargs rm`) names none.
 */
export function namesNoPath(words: Word[]): boolean {
  const stripped = stripPrefix(words);
  const first = stripped.words[0];
  if (first === undefined || !isRemover(commandName(first.text))) return false;
  const operands = removalOperands(stripped.words.slice(1));
  // The placeholder is recognised in the words the CHILD typed: `stripPrefix` has already
  // consumed `-I`'s spaced value, and an attached `-I{}`/`-i%` sits among what remains, so
  // only the raw segment can say which of the surviving operands are substitutions. A line
  // that ran through no `xargs` has no placeholder at all, and `''` matches nothing.
  const placeholders = xargsPlaceholders(words);
  return operands.every((w) => placeholders.includes(w.text));
}

/**
 * What a `find` whose expression holds an `-exec` removes. When the matches are handed to
 * a remover downstream, the victims are that remover's and the start paths name them;
 * otherwise only an `-exec` of a remover over literal start paths names its own victims.
 * A `find` that named no start path names no tree and is refused, not judged on the cwd
 * it may not have been in.
 */
function execRemovals(starts: Word[], expr: Word[], pipedIntoRemover: boolean): Word[] {
  const execExpr = expr.slice(expr.findIndex((a) => FIND_EXEC.has(a.text)));
  const cmd = execExpr.find((a) => !a.text.startsWith("-"));
  // A pipe can only carry what the `find` PRINTS, and `-exec <cmd>` prints what `<cmd>`
  // prints: an `rm` prints nothing, so a remover downstream has no victims to name and
  // the line is judged as its `-exec` alone (`execRemovals` below). A non-remover such as
  // `-exec ls` prints the matches, so whatever reaches the remover are those matches —
  // the incident's sweep in another spelling, judged by the same start paths.
  if (pipedIntoRemover && !printsNothing(cmd)) {
    return starts.length > 0 ? starts : [{ text: ".", dyn: false }];
  }
  if (cmd === undefined || !isRemover(commandName(cmd.text))) return [];
  // A start path is the tree the victims live under, so a name test narrows within it
  // without hiding it — judged, like the `-print0 | xargs rm` shape above. With no start
  // path the line names no tree and says nothing the reader can resolve: refused.
  if (starts.length === 0) return [UNNAMED_DIR];
  return starts;
}

/**
 * Whether the command `-exec` runs is known to print nothing, so a downstream remover
 * would be deleting nothing the line can name. Only the removers are known silent: any
 * other command (or a name this rule cannot read) may print its matches.
 */
function printsNothing(cmd: Word | undefined): boolean {
  return cmd !== undefined && isRemover(commandName(cmd.text));
}

/** The start paths and the expression of a `find`'s arguments. */
function splitFind(args: Word[]): { starts: Word[]; expr: Word[] } {
  let from = 0;
  while (from < args.length && /^-[HLP]$/.test(args[from]?.text ?? "")) from++;
  let to = from;
  while (to < args.length && !/^[-(!]/.test(args[to]?.text ?? "")) to++;
  return { starts: args.slice(from, to), expr: args.slice(to) };
}
