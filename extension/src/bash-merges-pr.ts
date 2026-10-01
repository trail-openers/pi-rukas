/**
 * bash-merges-pr — the merge matcher (`mergesPr`).
 *
 * #912 — the merge guard (merge-guard.ts) calls this ahead of every
 * trust/sandbox bypass, exactly like `createsIssue`: ops holds an
 * `oo gh pr merge*` / `oo glab mr merge*` grant in agents.json, and in
 * trust/sandbox mode nothing else checks it.
 *
 * The doors (all on the QUOTE-STRIPPED command, scan-not-anchor):
 *
 *   - `gh pr merge …` / `glab mr merge …` (with or without the `oo`
 *     prefix, chained after `cd x && …` or any other command, `timeout` /
 *     `nice` / `env` wrappers),
 *   - `gh pr merge` with NO number — the CLI resolves the PR from the
 *     current branch; the guard resolves it via `gh pr view --json number`
 *     before deciding,
 *   - the gh REST door: `gh api repos/{o}/{r}/pulls/{n}/merge` — gh api
 *     DEFAULTS TO POST/PUT (like the issues-collection door), so a
 *     "read-looking" call on /pulls/N/merge IS the write; the no-number
 *     `gh api repos/{o}/{r}/pulls/merge` shape is the same door,
 *   - the glab REST door: `glab api /projects/{id}/mr/{n}/merge` —
 *     method-AWARE (glab api does NOT default to POST, exactly the
 *     issues-door rule): only an EXPLICIT PUT/POST (`-X PUT`, `--method
 *     POST`, …) or body fields (`-f`/`-F`/`--field`) is a merge; an
 *     unqualified call or an explicit GET stays open.
 *
 * Reads stay open: `gh pr view`, `gh pr checks`, `gh api repos/o/r/pulls/42`
 * (no `/merge` suffix), `glab mr view`, and anything only quoted (`echo
 * "gh pr merge 12"`). An unterminated quote fails closed the way
 * `stripQuotedSegments` returns the raw command.
 *
 * Returns the matched span (for the refusal text), or undefined when the
 * command does not merge.
 */

import { stripQuotedSegments } from "./bash-command-parser.ts";
import { mergeVerbArgs } from "./merge-parse.ts";

export function mergesPr(command: string): string | undefined {
  const c = stripQuotedSegments(command);
  const FORGE = "(?:^|[;&|]|\\s)(?:oo\\s+)?(?:gh|glab)\\s+";
  // The verb door: `gh pr merge` / `glab mr merge`, number optional.
  const verb = new RegExp(`${FORGE}(?:pr\\s+merge|mr\\s+merge)(?:\\s|$)`).exec(c);
  if (verb?.[0]) return verb[0].trim();

  // Subshell verb door (#955): the raw command carries a shell-eval
  // invocation (`bash -c …`, `sh -c …`, `eval …`, with `env`/`oo` wrappers)
  // whose INNER string contains a merge verb. `mergeVerbArgs` unwraps the
  // shell-eval layer recursively (depth 3) and matches the verb on the
  // innermost segment. The matched span returned here is the inner verb
  // (not the outer shell wrapper) — the refusal text names the actual merge
  // command.
  const innerArgs = mergeVerbArgs(command);
  if (innerArgs !== undefined) {
    // The inner string contained a merge verb — but only if the inner
    // string itself is not a quoted argument (e.g. `echo "pr merge"` is
    // quoted text, not a command). The recursive match in mergeVerbArgs
    // handles this: it strips quotes from the inner string before matching,
    // so a quoted verb in the inner string does not match. We can trust
    // that if mergeVerbArgs returned non-undefined, the inner string had
    // an unquoted merge verb.
    //
    // However, the top-level call to mergeVerbArgs does NOT strip quotes
    // before matching — the verb regex runs on the raw command. So a
    // quoted `gh pr merge` inside a --body flag value would match the
    // regex even though it's quoted. We need to verify the matched span
    // is not inside a quoted segment: run stripQuotedSegments on the
    // command and check the verb is still present in the stripped text.
    let text = command;
    for (let depth = 0; depth < 3; depth++) {
      const inner = unwrapOne(text);
      if (inner !== undefined) {
        text = inner;
        continue;
      }
      const m = mergeVerbRegex().exec(text);
      if (m) {
        // Verify the match is not inside a quoted segment: strip quotes
        // and check the verb is still present in the stripped text.
        const stripped = stripQuotedSegments(text);
        const strippedMatch = mergeVerbRegex().exec(stripped);
        if (strippedMatch) return strippedMatch[0].trim();
        return undefined;
      }
      return undefined;
    }
    return undefined;
  }

  // REST door, gh: `gh api` on /pulls/{n}/merge — gh api defaults to
  // POST/PUT when no --method is given, so the /merge suffix IS the write
  // even when it "looks like a read". The no-number `.../pulls/merge`
  // shape is the same door.
  const ghApiMatch = new RegExp(`${FORGE}api\\s+(repos/[^\\s]+)`).exec(c);
  const ghEndpoint = ghApiMatch?.[1] ?? "";
  if (ghApiMatch && /\/pulls(?:\/[^\s/?#]+)?\/merge(?:[?&#\s]|$)/.test(ghEndpoint)) {
    const rest = c.slice(ghApiMatch.index);
    // The door is a WRITE unless the command is an explicit GET AND carries
    // no body fields — gh api's `-f`/`-F`/`--field` flags force a PUT
    // regardless of `--method`, so `--method GET --field x` is still the write.
    const explicitGet = /\s(?:--method|-X)\s+get\b/i.test(rest);
    const hasBodyFields = /\s(?:-f|-F|--field)(?:=|\s)/.test(rest);
    if (!explicitGet || hasBodyFields) return (ghApiMatch?.[0] ?? "").trim();
  }
  // REST door, glab: `glab api` on /mr/{n}/merge or
  // /merge_requests/{n}/merge (the repo's canonical shape) — method-AWARE:
  // blocked only when the command EXPLICITLY writes (glab api does not
  // default to POST the way gh api does; copying the gh rule here would
  // over-block legitimate reads). Method names are case-insensitive.
  const glabApiMatch = new RegExp(
    `${FORGE}api\\s+(/projects/[^\\s]+)/(?:mr|merge_requests)(?:/[^\\s/?#]+)?/merge(?:[?&#\\s]|$)`,
  ).exec(c);
  if (glabApiMatch?.[0] !== undefined) {
    const rest = c.slice(glabApiMatch.index);
    const explicitGet = /\s(?:--method|-X)\s+get\b/i.test(rest);
    const writes =
      /\s(?:-X|-f|-F)\s+(?:put|post)\b/i.test(rest) ||
      /\s--method\s+(?:put|post)\b/i.test(rest) ||
      /\s(?:-f|-F|--field)(?:=|\s)/.test(rest);
    if (!explicitGet && writes) return glabApiMatch[0].trim();
  }
  return undefined;
}

function mergeVerbRegex(): RegExp {
  return /(?:^|[;&|]|\s)(?:oo\s+)?(?:gh|glab)(?:\s+-R\s+\S+)?\s+(?:pr\s+merge|mr\s+merge)(?:\s|$)/;
}

/**
 * Unwrap ONE shell-eval layer (`bash -c …`, `sh -c …`, `eval …`, with
 * `env`/`oo` wrappers) to its quoted string argument. Reimplemented here
 * (not imported from merge-parse.ts) because merge-parse.ts is imported BY
 * this file — importing it back would be a cycle. The logic is identical to
 * `unwrapShellEval` in merge-parse.ts.
 */
function unwrapOne(command: string): string | undefined {
  const tokens = rawTokens(command);
  if (tokens.terminated === false) return undefined;
  let i = 0;
  const n = tokens.list.length;
  while (i < n) {
    const t = tokens.list[i] ?? "";
    if (t === ";" || t === "&&" || t === "|" || t === "||") {
      i++;
      continue;
    }
    if (t === "oo") {
      i++;
      continue;
    }
    if (t === "env") {
      i++;
      while (i < n && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens.list[i] ?? "")) i++;
      if (i >= n) return undefined;
      continue;
    }
    const q = t[0];
    if (q === "'" || q === '"') return undefined;
    if (t === "bash" || t === "sh" || t === "zsh" || t === "dash") {
      let j = i + 1;
      let sawC = false;
      while (j < n) {
        const f = tokens.list[j] ?? "";
        if (f === "-c" || f === "-lc") {
          sawC = true;
          j++;
          break;
        }
        if (f.startsWith("-")) {
          j++;
          continue;
        }
        break;
      }
      if (!sawC) return undefined;
      const arg = tokens.list[j];
      if (arg === undefined) return undefined;
      const aq = arg[0];
      if (aq !== "'" && aq !== '"') return undefined;
      const inner = arg.slice(1, -1);
      return inner.length > 0 ? inner : undefined;
    }
    if (t === "eval") {
      const arg = tokens.list[i + 1];
      if (arg === undefined) return undefined;
      const aq = arg[0];
      if (aq !== "'" && aq !== '"') return undefined;
      const inner = arg.slice(1, -1);
      return inner.length > 0 ? inner : undefined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * The raw-command token walk: quoted runs are kept as a single token WITH
 * their outer quotes; separators are their own tokens. `terminated` is
 * false when a quote never closes.
 */
function rawTokens(raw: string): { list: string[]; terminated: boolean } {
  const list: string[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i] ?? "";
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "&" && (raw[i + 1] ?? "") === "&") {
      list.push("&&");
      i += 2;
      continue;
    }
    if (ch === "|" && (raw[i + 1] ?? "") === "|") {
      list.push("||");
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "|") {
      list.push(ch);
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const q = ch;
      i++;
      let closed = false;
      let buf = "";
      while (i < n) {
        const c2 = raw[i] ?? "";
        if (q === '"' && c2 === "\\" && i + 1 < n) {
          buf += c2 + (raw[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (c2 === q) {
          closed = true;
          i++;
          break;
        }
        buf += c2;
        i++;
      }
      if (!closed) return { list, terminated: false };
      list.push(q + buf + q);
      continue;
    }
    const start = i;
    while (i < n && !/\s/.test(raw[i] ?? "") && raw[i] !== "'" && raw[i] !== '"') i++;
    list.push(raw.slice(start, i));
  }
  return { list, terminated: true };
}
