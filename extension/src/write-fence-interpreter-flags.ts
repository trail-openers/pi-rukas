/**
 * write-fence-interpreter-flags — the interpreter call forms whose script body the
 * write fence's readers read, as ONE table (#2200 D7, #2352).
 *
 * Both readers that look inside a one-liner — the deletion rule's interpreter reader
 * and the reviewer write guard's position reader — find the body by the flag that
 * carries it, so each of them used to name the flags on its own. Two lists of the
 * same flags drift, and the drift is a hole: the position reader kept only the first
 * spelling (`node -e`) while the deletion reader had long since learned `--eval` and
 * `--print`, so the same body read through one flag and not the others.
 *
 * A leaf that imports only the lexer's `Word`: a table of what each runtime accepts,
 * the walk that lifts the body word out of the argument list, and nothing else.
 */

import type { Word } from "./write-fence-bash-lex.ts";

/**
 * The body-carrying flags of each interpreter the fence reads. Every spelling is the
 * runtime's own: node and bun accept all four (`-e`/`--eval` run the string,
 * `-p`/`--print` run it and print the result), python and python3 take `-c`, perl and
 * ruby take `-e`.
 */
export const INTERPRETER_FLAGS: Record<string, readonly string[]> = {
  bun: ["-e", "--eval", "-p", "--print"],
  node: ["-e", "--eval", "-p", "--print"],
  python: ["-c"],
  python3: ["-c"],
  perl: ["-e"],
  ruby: ["-e"],
};

/** The flags that carry `name`'s body; undefined for any command this table does not list. */
export function interpreterFlags(name: string): readonly string[] | undefined {
  return INTERPRETER_FLAGS[name];
}

/**
 * The body word of an interpreter call, or undefined when the call names none: each
 * flag of `INTERPRETER_FLAGS` carries the word after it, and a long one carries it
 * attached as `--flag=BODY` too. Exported because both readers of a one-liner need the
 * same walk of the argument list: the deletion rule reads the body for a delete call,
 * the reviewer write guard reads it for a write shape.
 */
export function interpreterBody(args: Word[], flags: readonly string[]): Word | undefined {
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
