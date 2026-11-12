/**
 * write-fence-deletion-interpreter — the interpreter half of the deletion rule
 * (#2200 D7): the one-liner that deletes through a script the operand table cannot
 * see, because its path lives inside the body, not among the command's words.
 *
 * `bun -e`, `node -e`/`--eval`/`--print`, `python -c`, `python3 -c`, `perl -e` and
 * `ruby -e` are the forms read here. They are NOT added to the writers table:
 * that table is shared with the WRITE fence, and putting `bun`/`node`/`python`
 * into its general write list would change what the write fence refuses for every
 * dispatch, which is not what this issue asks.
 *
 * Fail-closed in the deletion rule's own vocabulary: a body the shell builds at run
 * time, or a body that deletes but names no path this reader can lift out of it, is
 * refused as unreadable rather than waved through.
 */

import path from "node:path";
import type { Word } from "./write-fence-bash-lex.ts";
import { expandHome } from "./write-fence-path.ts";

/** Why an interpreter call whose target cannot be read is refused. */
export const INTERPRETER_TARGET_REASON =
  "it deletes through an interpreter whose target cannot be read. Name the path literally, or report the need to the PM";

/** The interpreter call forms whose body this rule reads (#2200 D7). */
const INTERPRETERS: Record<string, readonly string[]> = {
  bun: ["-e", "--eval", "--print"],
  node: ["-e", "--eval", "--print"],
  python: ["-c"],
  python3: ["-c"],
  perl: ["-e"],
  ruby: ["-e"],
};

/**
 * The deletion calls an interpreter body may hold. Ruby's spellings are named with
 * their `FileUtils`/`File` receiver because a bare `rm` is a shell command every
 * body may mention in a message, and `unlink` is a JS/Python verb already read on
 * its own — the receiver is what makes the match a deletion rather than a word.
 */
const DELETE_CALL =
  /\b(?:rmSync|unlinkSync|rmdirSync|removeSync|shutil\.rmtree|os\.(?:remove|unlink|rmdir)\b|Path\([^)]*\)\s*\.\s*unlink|FileUtils\.(?:rm_rf|rm_f|remove_entry|remove_entry_secure)|File\.(?:delete|unlink)|rm\b|rmdir\b|unlink\b)/;

/** A quoted literal inside a script body. */
const STRING_ARG = /(['"])((?:[^'"\\\n]|\\.)*)\1/g;

/**
 * A template literal that interpolates a run-time value (`${…}`). A path built
 * this way is the incident's own shape — the target assembled from the
 * environment's home directory — and the string it produces is not knowable here,
 * so the call is refused rather than judged on a branch of the template.
 */
const TEMPLATE_WITH_SUBSTITUTION = /`[^`]*\$\{[^`]*`/;

/** Is this command one whose words this rule reads at all? */
export function isInterpreter(name: string): boolean {
  return name in INTERPRETERS;
}

/**
 * The quoted literals a script body deletes; empty when it names no path at all.
 * Exported for the deletion tests, which read the same literal rule the hook uses.
 */
export function interpreterLiterals(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(STRING_ARG)) {
    const raw = match[2] ?? "";
    if (raw !== "" && readsAsPath(raw)) out.push(raw);
  }
  return out;
}

/** Does this quoted literal read as a path rather than a message, a flag or a pattern? */
function readsAsPath(p: string): boolean {
  if (p.startsWith("-")) return false;
  return p.includes("/") || p === "~" || p.startsWith("~/") || /^[\w.@+-]+$/.test(p);
}

/**
 * A delete target the body builds itself: an env read, an argv slot, a `+` join or
 * an interpolation. `process.env.HOME` in a body that deletes is exactly the
 * incident's script, and the string it produces is not knowable here.
 */
const DYNAMIC_TARGET =
  /(?:process\.env|os\.environ|sys\.argv|process\.argv|argv\[|\$[A-Za-z_|]|\+\s*[A-Za-z_$]|[A-Za-z_$][\w$]*\s*\+)/;

/**
 * The body word of an interpreter call, or undefined when the call names none:
 * `-e`/`--eval`/`--print` for bun and node, `-c` for python, `-e` for perl and
 * ruby, `--flag=BODY` too.
 */
function interpreterBody(args: Word[], flags: readonly string[]): Word | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as Word;
    if (a.text === "--") return args[k + 1];
    if (flags.includes(a.text)) return args[k + 1];
    const inline = flags.find((f) => f.startsWith("--") && a.text.startsWith(`${f}=`));
    if (inline !== undefined) return { text: a.text.slice(inline.length + 1), dyn: a.dyn };
    if (!a.text.startsWith("-")) return undefined;
  }
  return undefined;
}

/**
 * The paths an interpreter call deletes, already absolute; empty when the call is
 * not an interpreter deletion. A run-time-built body, or a body that deletes without
 * naming a path, returns the single refusal path `undefined` through `reason` — the
 * caller turns each entry into a delete position judged from `dir`.
 */
export function interpreterDeletions(
  name: string,
  args: Word[],
  dir: string,
): { path: string }[] | { reason: string } {
  const flags = INTERPRETERS[name];
  if (flags === undefined) return [];
  const body = interpreterBody(args, flags);
  if (body === undefined) return [];
  if (body.dyn) return { reason: INTERPRETER_TARGET_REASON };
  if (!DELETE_CALL.test(body.text)) return [];
  // A target assembled at run time — an interpolation, a concatenation, an env
  // read — cannot be judged, and a body that deletes without naming one is the
  // same case in another spelling. Both are refused, not waved through.
  if (DYNAMIC_TARGET.test(body.text) || TEMPLATE_WITH_SUBSTITUTION.test(body.text)) {
    return { reason: INTERPRETER_TARGET_REASON };
  }
  const literals = interpreterLiterals(body.text);
  if (literals.length === 0) return { reason: INTERPRETER_TARGET_REASON };
  return literals.map((p) => ({ path: absolutise(p, dir) }));
}

/** Resolve a deletion word the way the child's shell would, from `dir`. */
function absolutise(text: string, dir: string): string {
  const expanded = expandHome(text);
  return path.isAbsolute(expanded) ? expanded : path.resolve(dir, expanded);
}
