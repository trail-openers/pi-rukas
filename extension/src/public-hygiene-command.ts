/**
 * public-hygiene-command — the words a publish scan must read, after the runner
 * prefixes are gone (#1788 round 6).
 *
 * The scan used to skip only `oo` and `NAME=value`. Everything else that runs a
 * command for you — `sudo`, `env`, `timeout`, `nohup`, `watch`, `xargs`, `exec`,
 * `nice`, `command` — left its words in front of `gh`/`git`, so the noun tables
 * found no publish and the command went unchecked, fail-closed body-file and
 * substitution refusals included. The stripping rule already existed, in
 * `unwrap` (bash-destructive-write.ts), owned by the memory write guard: one
 * copy, called from both.
 *
 * `unwrap` does NOT skip `oo` or `NAME=value` in every position the prefix rule
 * covers (it drops assignments only at the head, and knows nothing of this
 * harness's verbose runner), so `commandPrefixLength` still runs after it. The
 * two are complementary, not overlapping: `unwrap` handles process wrappers and
 * their option operands, the prefix rule handles `oo` and any assignment the
 * wrapper pass left behind.
 */

import { simpleCommands, unwrap } from "./bash-destructive-write.ts";
import { commandPrefixLength } from "./public-hygiene-prefix.ts";

/**
 * The words of ONE simple command that a publish reader must judge: the wrapper
 * pass first, then the `oo`/`NAME=value` prefix it cannot skip.
 *
 * Empty when the command had nothing left after the stripping (`env -S …`,
 * whose payload is a command line of its own and reaches the readers through
 * `publishCommandLines`).
 */
export function publishArgv(argv: readonly string[]): string[] {
  const { argv: rest } = unwrap(argv);
  return rest.slice(commandPrefixLength(rest));
}

/**
 * Every simple command of `command`, wrapper-stripped and prefix-skipped — the
 * one word list every publish reader and every publish target read walks.
 *
 * The `env -S STRING` form is re-split here rather than passed through: its
 * payload is itself a command line, so it is split as one and words after it
 * become quoted operands of that line (the same reading the memory write guard
 * gives it). `true`/`false` after an `env -S` payload is a real flag of `env`,
 * never a `gh` flag, and it is refused as an unreadable operand rather than
 * misread as a publish — the conservative side, which is the only side a guard
 * may take.
 */
export function publishCommandLines(command: string): string[][] {
  const lines: string[][] = [];
  for (const words of simpleCommands(command)) {
    const { argv, split } = unwrap(words);
    if (split === undefined) {
      lines.push(argv.slice(commandPrefixLength(argv)));
      continue;
    }
    const [payload = "", ...tail] = split;
    lines.push(...publishCommandLines([payload, ...tail.map(quoteWord)].join(" ")));
  }
  return lines;
}

/** Shell-quote one word, so the re-split sees it as the same single word. */
const quoteWord = (w: string): string => `'${w.replace(/'/g, "'\\''")}'`;
