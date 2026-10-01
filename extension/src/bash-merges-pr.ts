import { stripQuotedSegments } from "./bash-command-parser.ts";
import { mergeVerbArgs, mergeVerbUnwrapOne } from "./merge-parse.ts";

/**
 * bash-merges-pr — the merge matcher (`mergesPr`).
 *
 * Does this command merge a PR/MR (or a REST door that does)?
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
  //
  // The quote-stripping verification applies ONLY to the original command
  // (to catch a verb that lives inside a top-level quoted segment like
  // `echo "gh pr merge 17"`). After unwrapping, the inner string IS the
  // command — quotes in it are literal quoting of sub-arguments, not
  // evidence the whole thing is quoted data.
  const innerArgs = mergeVerbArgs(command);
  if (innerArgs !== undefined) {
    // Find the innermost segment that carries the verb and return the
    // matched span from there. `mergeVerbArgs` already verified the verb
    // is a real (unquoted) invocation — it unwraps shell-eval layers and
    // only matches on the innermost command segment, where a quoted verb
    // (`echo "gh pr merge 17"`) is inert because the verb regex requires
    // the `gh`/`glab` word to be unquoted.
    let text = command;
    for (let depth = 0; depth < 3; depth++) {
      const inner = mergeVerbUnwrapOne(text);
      if (inner !== undefined) {
        text = inner;
        continue;
      }
      const m =
        /(?:^|[;&|]|\s)(?:oo\s+)?(?:gh|glab)(?:\s+(?:-R|--repo)\s+\S+)?\s+(?:pr\s+merge|mr\s+merge)(?:\s|$)/.exec(
          text,
        );
      if (m) return m[0].trim();
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
