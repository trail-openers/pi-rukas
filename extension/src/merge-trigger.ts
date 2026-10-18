/**
 * merge-trigger — step 1 of the merge classifier: does this command need the
 * strict merge grammar at all, and if it is held, WHAT was held.
 *
 * #962 put the trigger here; #1417 added the second half of its answer. The
 * trigger used to return a bare reason code (`"body-indirect"`), which the
 * guard pasted into a refusal as `[reason: body-ind…]` — truncated in the
 * console, and never explained itself. So `triggerCode` returns a `HoldReason`
 * `{ code, detail }`: the code stays the stable name tests and docs cite, and
 * `detail` names the thing that was held (the merge word, the verb pair, the
 * brace pattern) so the refusal can say what to change.
 *
 * Split out of merge-allowlist.ts, which owns step 2 (the grammar over
 * lexed words) and the read-only exemption; the two halves share only the
 * `HoldReason` shape, so the file-size limit (#12) falls on the seam rather
 * than on a comment budget.
 *
 * Linearity is load-bearing: this runs on every bash tool_call, so every
 * regex here is anchored, bounded or literal, and each view is scanned once
 * per pattern rather than once per pattern per view (the pre-#1417 shape
 * re-tested all four patterns over both texts even after one had matched).
 */

import { type HoldReason, gluedShortValue } from "./merge-allowlist.ts";
import {
  BRACE_EXPANSION,
  FORGE_WORD,
  HTTP_CLIENT,
  MERGE_WORD,
  VERB_PAIR,
  ansiC,
  hasComplexCommandWord,
  quotedView,
} from "./merge-lex-views.ts";

/** A forge's own `api`/`graphql` call, or an HTTP client aimed at a forge host. */
const FORGE_NAME = /(?:^|[^a-z0-9_])(?:gh|glab)(?![a-z0-9_])/i;
const API_WORD = /(?:^|[\s'"])(?:api|graphql)(?![a-z0-9_])/i;
const FORGE_HOST = /api\.github\.com|github\.com|gitlab|graphql/i;

/** Whether the command calls a forge's API or an HTTP client aimed at a forge. */
function isForgeOrHttpCall(command: string): boolean {
  return (
    (FORGE_NAME.test(command) && API_WORD.test(command)) ||
    (HTTP_CLIENT.test(command) && FORGE_HOST.test(command))
  );
}

/** A request body that is not a literal: a file, stdin or a shell expansion. */
function bodyIndirect(command: string): boolean {
  // BODY_FILE's own shape lives in merge-allowlist.ts with the rest of the
  // literal-text patterns; this is the expansion half of the same rule.
  return /[$`]|<\(/.test(quotedView(command, true)) || BODY_INDIRECT_FILE.test(command);
}

/** A body read from a file or stdin: `k=@f`, `-d @f`, `-T f`, `--post-file f`, … */
const BODY_INDIRECT_FILE =
  /(?:^|\s)[^\s=]*=@|(?:^|\s)-[dFT]\s*@|(?:^|\s)-T\b|--(?:data[\w-]*|form)\s+@|--data-urlencode\s+[^\s=@"']*@|--(?:upload-file|post-file|input)\b/;

/**
 * Step 1: does this command need the strict grammar at all? Returns the held
 * reason for a trigger that refuses without reading (`expansion-command-word`,
 * `body-indirect`, `brace-expansion`), a `""` code for an ordinary trigger the
 * grammar judges, or undefined for no trigger. The widened view only widens
 * the trigger; the grammar in `lex` decides.
 */
export function triggerCode(command: string): HoldReason | undefined {
  const widened = command
    .replace(/\$'((?:[^'\\]|\\[\s\S])*)'/g, (_, body: string) => ansiC(body))
    .replace(/\\\r?\n/g, "")
    .replace(/\$(?=['"])/g, "")
    .replace(/['"\\]/g, "");
  // #1479 — the glued-view: a short flag's value that is glued to the flag
  // letter (`-bmerge` = flag `-b` + value `merge`) is invisible to the word-
  // boundary patterns above, because the value shares the flag's token. The
  // view re-emits each glued value as its own word so the patterns can see it.
  // Only values that already spell a trigger word are added, so the view is a
  // no-op for the overwhelming majority of commands. A short flag is `-` +
  // one letter; the value is everything after the second character. A long
  // flag (`--body`) never glues. `=`-prefixed forms (`-b=x`) are already
  // word-bounded by the `=`.
  // Pre-check: the glued view costs a split and a per-word pass, and this
  // runs on every bash tool_call, so it is built only when a glued value
  // spelling a merge word is even possible — the text must contain `merge`
  // as a substring (case-insensitive; the word-boundary test would miss the
  // very case this view exists for, where the value is glued to a flag
  // letter and the boundary test fails), and a glued shape (a `-` next to a
  // letter) at all. Both tests are cheap linear scans; the common case
  // (no merge substring, no flag) exits here with the input unchanged and
  // zero per-word work.
  const gluedView: string =
    command.toLowerCase().includes("merge") && /-\p{L}/u.test(command)
      ? (() => {
          // (Caller-specific: the trigger RE-EMITS each merged value as its
          // own word for the patterns; the allowlist only wants a boolean.
          // The "is this a glued short flag with value V" rule is shared —
          // see gluedShortValue in merge-allowlist.ts.)
          const gluedParts: string[] = [];
          for (const w of command.split(/\s+/)) {
            const value = gluedShortValue(w);
            if (value !== undefined && MERGE_WORD.test(` ${value}`)) gluedParts.push(value);
          }
          return gluedParts.length > 0 ? `${command} ${gluedParts.join(" ")}` : command;
        })()
      : command;
  let verb = false;
  let merge = false;
  let forge = false;
  let mutation = false;
  let verbText: string | undefined;
  let mergeText: string | undefined;
  let forgeText: string | undefined;
  for (const t of [command, gluedView, widened]) {
    if (!verb && VERB_PAIR.test(t)) {
      verb = true;
      verbText = t;
    }
    if (!merge && MERGE_WORD.test(t)) {
      merge = true;
      mergeText = t;
    }
    if (!forge && FORGE_WORD.test(t)) {
      forge = true;
      forgeText = t;
    }
    if (!mutation && /mutation/i.test(t) && /merge/i.test(t)) mutation = true;
  }
  if ((merge || verb) && hasComplexCommandWord(command)) {
    return {
      code: "expansion-command-word",
      detail:
        "a command word built by expansion, quoting or escaping, so the tool bash would exec is not readable here",
    };
  }
  if (isForgeOrHttpCall(command) && bodyIndirect(command)) {
    return {
      code: "body-indirect",
      detail:
        "a forge/HTTP request whose body is read from a file, stdin or a shell expansion, so the guard cannot see what it sends",
    };
  }
  if (forge && BRACE_EXPANSION.test(quotedView(command, false))) {
    return {
      code: "brace-expansion",
      detail:
        "a brace pattern bash would expand sits beside a forge word, so the verb is not readable here",
    };
  }
  // What was held, named by the first trigger that fired and the word it
  // matched — the agent reading the refusal sees the token, not a rule name.
  const heldBy = (): string => {
    if (verbText !== undefined) {
      const m = VERB_PAIR.exec(verbText);
      return `a merge verb pair \`${(m?.[0] ?? "pr merge").trim()}\``;
    }
    if (mergeText !== undefined) {
      const m = MERGE_WORD.exec(mergeText);
      return `the merge word \`${(m?.[0] ?? "merge").replace(/^[^a-z0-9_]/i, "")}\``;
    }
    if (mutation) return "a GraphQL `mutation` naming a merge";
    if (forgeText !== undefined) {
      const m = FORGE_WORD.exec(forgeText);
      return `the forge/HTTP/interpreter word \`${(m?.[0] ?? "gh").trim()}\` beside a merge word`;
    }
    return "a forge-adjacent word";
  };
  if (verb) return { code: "", detail: heldBy() };
  return forge && (merge || mutation) ? { code: "", detail: heldBy() } : undefined;
}
