import { stripQuotedSegments } from "./bash-command-parser.ts";
import { mergeVerbArgs } from "./merge-parse.ts";
import { shellSegments } from "./merge-tokens.ts";
import { innerBodies, matchMergeVerb } from "./merge-verb-head.ts";

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
  // Verb door, segment-wise (#955 round-2 hardening): the legacy door
  // above ran one regex over the quote-stripped WHOLE command, which is
  // why it missed process-wrapper prefixes (`timeout 30 gh pr merge 17`),
  // forge paths (`/usr/bin/gh …`), and merges inside `( … )` / `$( … )` /
  // backtick bodies. Those are matched here: every shell segment's head is
  // tested with the wrapper-stripped `matchMergeVerb` (merge-verb-head.ts),
  // and `mergeVerbArgs` — which walks the same layers and recurses into
  // inner-body constructs — returns a non-undefined tail when any inner
  // segment carries the verb (or the empty-string fail-closed tail when
  // the command is unparseable). A quoted verb (`echo "gh pr merge 17"`)
  // is inert in every layer: the segment head must be an UNQUOTED forge
  // word (a quoted token is neither a forge word nor a wrapper).
  //
  // This check runs BEFORE the REST doors and is the authoritative verb
  // door: when `mergeVerbArgs` returns non-undefined, the command merges
  // (the span is the inner verb, or the minimal fail-closed span). When
  // it returns undefined, the command does NOT merge via the verb door
  // (and the REST doors below are tried next).
  const innerArgs = mergeVerbArgs(command);
  if (innerArgs !== undefined) {
    const span = findVerbSpanInSegments(command, 0);
    // No span found (unparseable command, or a merge hidden past the
    // unwrap budget): fail closed with a minimal span.
    if (span !== undefined) return span;
    if (shellSegments(command).length === 0) return "gh pr merge";
    return "gh pr merge";
  }
  // No verb match: fall through to the REST doors below. The REST doors
  // match `gh api …/pulls/N/merge` and `glab api …/mr/N/merge` — command
  // shapes that `mergeVerbArgs` does not match (they use `api`, not `merge`
  // as the verb). The doors run over the command AND over every `( … )` /
  // `$( … )` / backtick body: a REST-door call inside a subshell or
  // substitution (`(gh api repos/o/r/pulls/17/merge)`, `x=$(gh api
  // repos/o/r/pulls/17/merge)`) is a live merge the guard must catch,
  // fail-closed — the same doctrine the verb door applies to those bodies.
  return restDoors([command, ...innerBodies(command)]);
}

/**
 * The REST doors, run over a list of command texts (the whole command plus
 * its `( … )` / `$( … )` / backtick bodies). Returns the matched span from
 * the FIRST text that carries a REST merge, or undefined.
 */
function restDoors(texts: string[]): string | undefined {
  for (const raw of texts) {
    const c = stripQuotedSegments(raw);
    const FORGE = "(?:^|[;&|]|\\s)(?:oo\\s+)?(?:gh|glab)\\s+";
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
  }
  return undefined;
}

/**
 * Find the matched verb span in the first segment (or nested inner body)
 * whose head matches `matchMergeVerb`. Recurses into `( … )` / `$( … )` /
 * backtick bodies the same way `mergeVerbArgs` does. The recursion
 * terminates: every body is a strict substring of the text that produced
 * it, so each recursive call operates on a strictly shorter string — no
 * exponential blowup on pathological input.
 */
function findVerbSpanInSegments(text: string, depth: number): string | undefined {
  const segments = shellSegments(text);
  if (segments.length === 0) return undefined;
  for (const seg of segments) {
    if (matchMergeVerb(seg) !== undefined) return segmentVerbSpan(seg);
    const bodies = innerBodies(seg);
    for (const body of bodies) {
      const span = findVerbSpanInSegments(body, depth + 1);
      if (span !== undefined) return span;
    }
  }
  return undefined;
}

/**
 * The matched verb span inside a segment whose head matched
 * `matchMergeVerb`: the (optionally path-qualified) forge word, an
 * optional `-R`/`--repo` value, and the `pr merge` / `mr merge` verb —
 * the span returned for the refusal text.
 */
function segmentVerbSpan(seg: string): string | undefined {
  const m =
    /(?:^|[\s;&|])(?:\/\S*\/)?(?:gh|glab)(?:\s+(?:-R|--repo|--project)\s+\S+)?\s+(?:pr|mr)\s+merge\b/.exec(
      seg,
    );
  if (!m) return undefined;
  // The match may start with the leading separator/space — the span is
  // the forge word onward, so slice it off and trim.
  return m[0].replace(/^\s*[;&|]?\s*/, "").trim();
}
