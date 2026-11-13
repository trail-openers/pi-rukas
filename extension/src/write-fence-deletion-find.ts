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
  commandName,
  isRemover,
  removalOperands,
  stripPrefix,
  withoutPlaceholder,
  xargsPlaceholders,
} from "./write-fence-bash-split.ts";

/** One simple command as the reader split it: its name, its words, and where it ran. */
export interface Command {
  name: string;
  args: Word[];
  dir: string;
}

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

/** Why an `-exec` whose first word is an option cannot be judged at all. */
const UNREADABLE_EXEC = refusalWord(
  "its -exec runs a command the rule cannot read, so what it deletes cannot be judged. Name the command directly after -exec",
);

/**
 * The words a `find` deletes, as it named them; empty when it removes nothing.
 * `pipedIntoRemover` says this `find`'s output is handed to a remover whose victims are
 * the matches (`find <paths> -print0 | xargs -0 -r rm -rf`) — the incident's own shape,
 * where nothing but this `find` names them. They are therefore judged by the `find`'s OWN
 * start paths: a sweep over a shared temp root is refused by those paths, and a cleanup of
 * the child's own tree is allowed by the same rule. A name pattern narrows within those
 * trees without hiding them, so it changes nothing; what is refused is a `find` that names
 * no tree at all.
 */
export function findRemovals(args: Word[], pipedIntoRemover = false): Word[] {
  const { starts, expr } = splitFind(args);
  const exec = expr.findIndex((a) => FIND_EXEC.has(a.text));
  if (exec >= 0) return execRemovals(starts, expr.slice(exec + 1), pipedIntoRemover);
  if (!expr.some((a) => a.text === "-delete")) {
    // No removal action of its own: a `find` piped into a remover is the sweep.
    return pipedIntoRemover ? (starts.length > 0 ? starts : [{ text: ".", dyn: false }]) : [];
  }
  return starts.length > 0 ? starts : [{ text: ".", dyn: false }];
}

/**
 * Whether a `find` on the left of this pipe hands the segment its victims. Through
 * `xargs` a remover substitutes the matches for its placeholder (`xargs rm -rf {}`,
 * `xargs -i rm -rf '{}'`) or names no path at all (`xargs -0 -r rm -rf`), so the victims
 * are the matches and only the `find`'s start paths name the trees they live in. Asked of
 * the segment AS TYPED, so a wrapper still in front of the remover is visible — it is what
 * makes a `{}` operand a substituted match rather than a path. A remover that also carries
 * a word which is not a placeholder (`xargs rm /tmp/victim`) did name a path, so that
 * literal is judged *and* the producer's start paths are judged too: the pipe carries every
 * match, so one in-tree literal cannot launder a sweep of a tree the `find` walks (#2200).
 * `producer` is the simple command on the left of the pipe, when there is one. A pipe
 * carries only what the producer prints, so a `find` whose own `-exec` runs a remover —
 * which prints nothing — hands over nothing, and the remover's victims are its own operands.
 */
export function removesMatches(words: Word[], producer?: Command): boolean {
  const stripped = stripPrefix(words);
  const first = stripped.words[0];
  if (first === undefined || !isRemover(commandName(first.text))) return false;
  const operands = removalOperands(stripped.words.slice(1));
  // The placeholders are read from the words the CHILD typed: `stripPrefix` has already
  // consumed `-I`'s spaced value, and an attached `-I{}`/`-i%` sits among what remains, so
  // only the raw segment can say which of the surviving operands are substitutions. A line
  // that ran through no `xargs` has no placeholder at all, and `''` matches nothing.
  const placeholders = xargsPlaceholders(words);
  const namesOnlyMatches =
    placeholders.length > 0
      ? withoutPlaceholder(operands, words).length === 0
      : operands.length === 0;
  if (namesOnlyMatches) return true;
  // The remover named literal paths of its own. It still has the pipe's victims — and so
  // the producer's start paths must be judged too — unless the producer is known to print
  // nothing, which is a `find` whose removal action is an `-exec` of a remover.
  return producer !== undefined && !printsNoMatches(producer);
}

/**
 * Whether a `find` on the left of a pipe prints no matches because its removal action is
 * an `-exec` of a remover (`find … -exec rm {} +`, which is silent). Any other command —
 * or a name this rule cannot read — may print its matches.
 */
function printsNoMatches(producer: Command): boolean {
  if (producer.name !== "find") return false;
  const exec = producer.args.findIndex((a) => FIND_EXEC.has(a.text));
  // Only a remover is silent; an unreadable command may print its matches, which is the
  // fail-closed answer for the pipe.
  return exec >= 0 && execIsRemover(producer.args.slice(exec + 1)) === true;
}

/**
 * Whether this `find`'s `-exec` runs a remover, or undefined when the action names no command at
 * all. The command is the FIRST word after the action, not the first word that happens not to be an
 * option: `find <tree> -exec -- rm -rf {} +` and `-exec -x rm …` would otherwise read as an `-exec`
 * of nothing, and the reader would see no removal action on a line that deletes. Whether that first
 * word is itself a remover or only a wrapper in front of one — `sudo`, or any other — is decided by
 * stripping it and asking the word behind it, so `-exec sudo rm -rf {} +` is read as the `rm` it is
 * while `-exec ls` prints its matches instead of removing them.
 */
function execIsRemover(expr: Word[]): boolean | undefined {
  const body = expr.slice(0, terminator(expr));
  const cmd = body[0];
  if (cmd === undefined) return undefined;
  const stripped = stripPrefix(body).words;
  const command = stripped[0];
  // No word survived the wrappers, so the action gave a wrapper and no program: it names no command,
  // which is the unreadable case the caller refuses rather than a pass.
  if (command === undefined) return undefined;
  // An option is not a program name, so the command this `-exec` runs cannot be read.
  if (command.text.startsWith("-")) return undefined;
  return isRemover(commandName(command.text));
}

/**
 * The remover this `-exec` runs, with the words after it, or undefined when the action runs no
 * remover. The operands are what the caller judges besides the start paths.
 */
function execCommand(expr: Word[]): { command: Word; operands: Word[] } | undefined {
  if (execIsRemover(expr) !== true) return undefined;
  const stripped = stripPrefix(expr.slice(0, terminator(expr))).words;
  const command = stripped[0];
  return command === undefined ? undefined : { command, operands: stripped.slice(1) };
}

/** The index of this `-exec` expression's terminator, or its length when it has none. */
function terminator(expr: Word[]): number {
  const end = expr.findIndex((a) => a.text === ";" || a.text === "+");
  return end < 0 ? expr.length : end;
}

/**
 * What a `find` whose expression holds an `-exec` removes. An `-exec` of a remover over
 * literal start paths names its own victims; an `-exec` of anything else deletes nothing,
 * so the line names no victim of its own. When the matches reach a remover downstream they
 * are that remover's victims and the start paths name them: the pipe carries every match,
 * so the start paths are judged whether or not the remover also named a literal of its own
 * — one in-tree literal must not launder a sweep of a tree the `find` walks. A `find` that
 * named no start path names no tree and is refused, not judged on the cwd it may not have
 * been in.
 */
function execRemovals(starts: Word[], execExpr: Word[], pipedIntoRemover: boolean): Word[] {
  // An `-exec` whose command cannot be read deletes whatever it deletes: the reader's
  // fail-closed vocabulary is a refusal, not a pass for the unreadable form.
  const silent = execIsRemover(execExpr);
  if (silent === undefined) return [UNREADABLE_EXEC];
  // A pipe carries only what the `find` prints, and an `-exec <cmd>` prints nothing but
  // what `<cmd>` prints. A non-remover such as `-exec ls` prints the matches, so whatever
  // reaches the remover downstream are those matches — the incident's sweep in another
  // spelling, judged by the same start paths. A silent `-exec` hands the pipe nothing, so
  // the remover downstream has only its own targets and this `find`'s start paths are not
  // victims of it.
  if (pipedIntoRemover && !silent) {
    return starts.length > 0 ? starts : [{ text: ".", dyn: false }];
  }
  if (!silent) return [];
  // A start path is the tree the victims live under, so a name test narrows within it
  // without hiding it — judged, like the `-print0 | xargs rm` shape above. With no start
  // path the line names no tree and says nothing the reader can resolve: refused.
  if (starts.length === 0) return [UNNAMED_DIR];
  // The remover's own literal operands are judged too: `find <in-tree> -exec rm -rf <outside> \;`
  // runs that remover once per match with the outside path spliced in verbatim, so an in-tree start
  // path cannot stand in for the tree it really deletes. A brace is the match `find` substitutes and
  // the terminator is not an operand, so neither is a path — which is what keeps the ordinary
  // `find <in-tree> -exec rm -rf {} +` a cleanup rather than a refusal.
  const literals = execCommand(execExpr);
  if (literals === undefined) return starts;
  return [...starts, ...withoutPlaceholder(removalOperands(literals.operands), execExpr)];
}

/** The start paths and the expression of a `find`'s arguments. */
function splitFind(args: Word[]): { starts: Word[]; expr: Word[] } {
  let from = 0;
  while (from < args.length && /^-[HLP]$/.test(args[from]?.text ?? "")) from++;
  let to = from;
  while (to < args.length && !/^[-(!]/.test(args[to]?.text ?? "")) to++;
  return { starts: args.slice(from, to), expr: args.slice(to) };
}
