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
 * The deletion calls an interpreter body may hold. Every spelling needs a call shape:
 * a `(` after the verb (`rm(`, `unlink(`), or a receiver that names a library before it
 * (`shutil.`, `os.`, `Path(...)`, Ruby's `FileUtils.`/`File.`). A bare `rm`, `rmdir` or
 * `unlink` is a word every body may carry in a message, a comment, or as a variable
 * name, and matching one of those refuses a one-liner that deletes nothing — which is
 * why the words alone are not the trigger. The exception the languages force: in Perl
 * `unlink "p"` and `unlink("p")` are both calls and a bareword never means plain text,
 * so the verb is read only for the interpreter that uses it, from the call form that
 * named it.
 */
/** The JS spellings: an fs call, or the plain `rm(`/`unlink(`/`rmdir(` call. */
const JS_CALL = /\b(?:rmSync|unlinkSync|rmdirSync|removeSync|rm\s*\(|rmdir\s*\(|unlink\s*\()/;

/**
 * The JS spellings that hand a REMOVER to a shell: an exec-family call whose first argument is
 * a remove command, or `Bun.spawn` of one. Naming the remover is what makes the call a deletion
 * rather than a shell-out — an `execSync("ls -l")` runs no delete and stays a normal command.
 */
const SHELL_DELETE_CALL =
  /\b(?:exec|execSync|spawn|spawnSync|execFile)\s*\(\s*['"`]\s*(?:rm|rmdir|unlink|shred)\b|\bBun\.(?:spawn|spawnSync)\s*\(\s*\[?\s*['"`]\s*(?:rm|rmdir|unlink|shred)\b/;

/** The Python spellings that hand a command to a shell: `os.system`, `os.popen`, `subprocess`'s call family. */
const PY_SHELL_CALL = /\bsubprocess\s*\.\s*\w+\s*\(|\bos\.(?:system|popen)\s*\(/;

/** The Ruby spellings that shell out: `system`, backticks, `%x{}`, `IO.popen`, `Open3`. */
const RUBY_SHELL_CALL = /\bsystem\s*\(|`|%x|\bIO\.popen\b|\bOpen3\b/;

/** The Perl spellings that shell out: `system`, backticks, `qx{}`, an open on a pipe. */
const PERL_SHELL_CALL = /\bsystem\s*\(|`|\bqx\b|\bIPC::Open/;

/** The Python spellings: `shutil.rmtree`, an `os.` removal, a `Path(...).unlink()`. */
const PYTHON_CALL =
  /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir)\s*\(|Path\([^)]*\)\s*\.\s*unlink)/;

/** The Ruby spellings, each named with the library that provides it. */
const RUBY_CALL =
  /\b(?:FileUtils\.(?:rm_rf|rm_f|remove_entry|remove_entry_secure)|File\.(?:delete|unlink)\s*\()/;

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

/** The call shape that makes this interpreter's body a deletion, per language. */
function callShape(name: string): RegExp {
  switch (name) {
    case "python":
    case "python3":
      return PYTHON_CALL;
    case "ruby":
      return RUBY_CALL;
    // Perl: both the list-operator form (`unlink "p"`) and the parenthesised call.
    case "perl":
      return /\bunlink\b|unlink\s*\(/;
    default:
      return JS_CALL;
  }
}

/**
 * Whether this body hands a command to a shell — which makes it a deletion whose target this
 * reader cannot resolve, so `interpreterDeletions` refuses it instead of judging the literals
 * the body happens to name. A bare shell MODULE name (`child_process`, `subprocess`) counts
 * only where the body also shows a delete: a body that neither deletes nor calls anything is
 * not a deletion, and a body that only imports a module deleted nothing.
 */
function shellsOut(name: string, body: string): boolean {
  // The shell call shapes that ARE the delete: `execSync("rm -rf …")` and `Bun.spawn(["rm", …])`
  // remove whatever the program they run removes, and the target lives in a string this reader
  // cannot resolve — so the call is refused whole, not judged on whichever literals the body
  // happens to name. A bare module name with no call (`import subprocess`) deletes nothing.
  if (SHELL_DELETE_CALL.test(body)) return true;
  const deletes = callShape(name).test(body);
  if (deletes && SHELL_MODULE.test(body)) return true;
  if (name === "python" || name === "python3") return PY_SHELL_CALL.test(body);
  if (name === "ruby") return RUBY_SHELL_CALL.test(body);
  if (name === "perl") return PERL_SHELL_CALL.test(body);
  return false;
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

/**
 * A quoted literal that names a module rather than a path. `"fs"`, `"fs/promises"`,
 * `"node:fs"`, `"path"` are what `require(…)` and `import … from …` take, so they are
 * what a target-less delete call carries as its ONLY literal: `require("fs").rmSync()`
 * deletes something and names nothing. Counting a specifier as a path made such a call
 * look readable and let it run; the python and ruby branches already refuse their
 * `import shutil` / `require "fileutils"` for the same reason (#2200 D7).
 */
const BARE_MODULES = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "path",
  "node:path",
  "os",
  "node:os",
  "process",
  "child_process",
  "node:child_process",
]);

/** The shape of a relative or home-relative reference: one that names a file, not a package. */
const RELATIVE_REFERENCE = /^(?:\.{1,2}\/|~)/;

/**
 * Does this quoted literal name a module the body imports? A specifier is a bare name,
 * a `pkg/sub` path, or a `node:` builtin — anything that resolves inside the runtime's
 * module graph. What the child typed is absolute or carries a `./`, `../` or `~/` prefix,
 * and every such reference is a file name even when its segments are plain words. The
 * bare names of the file-system modules are decided by the list above, which keeps a
 * plain relative path (`tmp/x`, `build`) reading as a path.
 */
function readsAsModuleSpecifier(p: string): boolean {
  if (p.startsWith("/") || p.startsWith("\\") || RELATIVE_REFERENCE.test(p)) return false;
  const bare = p.startsWith("node:") ? p.slice("node:".length) : p;
  if (BARE_MODULES.has(p) || BARE_MODULES.has(bare)) return true;
  if (p.startsWith("node:") || p.startsWith("@")) return true;
  return !/^[A-Za-z_][\w+.-]*(?:\/[\w+.@-]+)*$/.test(p);
}

/** Does this quoted literal read as a path rather than a message, a flag, a pattern or a module? */
function readsAsPath(p: string): boolean {
  if (p.startsWith("-")) return false;
  if (readsAsModuleSpecifier(p)) return false;
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
 * A body word that names a shell module rather than a shell call: the module a JS body
 * requires and python's `subprocess`. `shellsOut` counts one only for a body that also shows
 * a delete, so a body that merely imports the module is not a deletion.
 */
const SHELL_MODULE = /\bchild_process\b|\bsubprocess\b/;

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
  const deletes = callShape(name).test(body.text);
  // A body that hands the delete to a shell deletes something this reader never sees — for
  // the JS dialects the shell call IS the delete, so such a body counts as one even where no
  // `fs` call appears. Either way the target is unknowable here and the call is refused, not
  // judged on whichever literals the body happens to name.
  if (shellsOut(name, body.text)) return { reason: INTERPRETER_TARGET_REASON };
  if (!deletes) return [];
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
