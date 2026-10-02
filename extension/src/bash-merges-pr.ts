import { stripQuotedSegments } from "./bash-command-parser.ts";
import { mergeVerbArgs } from "./merge-parse.ts";
import { mergeVerbSpanRegex, shellSegments } from "./merge-tokens.ts";
import { innerBodies, matchMergeVerb, mergeVerbUnwrapOne } from "./merge-verb-head.ts";

/**
 * #955 (perf): maximum length (chars) of a merge-bearing command that will
 * be walked by the expensive segment/innerBody recursion. Commands longer
 * than this that contain `gh` or `glab` are blocked as too large to analyse
 * (fail closed) before the walk. 20000 chars is well above any legitimate
 * merge command (the longest realistic one is a few hundred chars) but well
 * below the size where the O(depth × length) walk becomes pathological
 * (a 64k-char nested-substitution command took >10s).
 */
const MERGE_COMMAND_SIZE_BOUND = 20000;

/**
 * The matched verb span inside a segment, or undefined when the segment does
 * not carry a merge verb (either directly or via per-segment shell-eval
 * unwrap). The span is located via `mergeVerbSpanRegex` on the segment (or
 * its unwrapped inner text) — the same regex the verb door uses, so the
 * span and the verb match cannot disagree.
 */
function segmentSpanOrUnwrapped(seg: string): string | undefined {
  if (matchMergeVerb(seg) !== undefined) return segmentVerbSpan(seg);
  // #955 round-4 per-segment unwrap: a shell-eval word in a later segment
  // (`cd x && bash -c "gh pr merge 17"`) is invisible to the whole-command
  // unwrap. Unwrap the segment and locate the span in the unwrapped inner
  // text — the span regex cannot see the verb inside the raw segment's
  // quoted body.
  const inner = mergeVerbUnwrapOne(seg);
  if (inner === undefined) return undefined;
  if (matchMergeVerb(inner) !== undefined) return segmentVerbSpan(inner) ?? "gh pr merge";
  return undefined;
}

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
  // #955 (perf): cheap pre-filter. Every guarded shape contains the literal
  // substring `merge` — the verb door (`pr merge` / `mr merge`), the REST
  // doors (`…/merge` path segment). A command without that substring cannot
  // match any door, so return immediately. This is O(n) and skips the
  // expensive segment walk on the common case (a bash tool call that is not
  // a merge). Eval-of-variable is out of scope (the guard only sees the raw
  // command text, not what a variable expands to).
  if (!command.includes("merge")) return undefined;
  // #955 (perf): size bound for merge-bearing commands. If the command is
  // longer than this threshold AND contains `gh` or `glab`, block it as too
  // large to analyse (fail closed) BEFORE running the expensive walk. The
  // expensive walk (segment recursion, innerBodies, restBodyTexts) is
  // O(depth × length) on pathological nested-substitution input, and a
  // 64k-char merge-bearing command can take >10s. 20000 chars is well above
  // any legitimate merge command (the longest realistic one is a few hundred
  // chars) but well below the size where the walk becomes pathological.
  // A merge-bearing command that does NOT contain `gh` or `glab` (e.g. a
  // long `git commit -m "…merge…"`) passes the size bound and is walked
  // normally — the pre-filter already confirmed it carries `merge`, so the
  // walk will determine whether it is a merge.
  if (
    command.length > MERGE_COMMAND_SIZE_BOUND &&
    (command.includes("gh") || command.includes("glab"))
  ) {
    return "gh pr merge";
  }
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
    const span = findVerbSpanInSegments(command);
    // No span found (unparseable command, or a merge hidden past the
    // unwrap budget): fail closed with a minimal span.
    if (span !== undefined) return span;
    return "gh pr merge";
  }
  // No verb match: fall through to the REST doors below. The REST doors
  // match `gh api …/pulls/N/merge` and `glab api …/mr/N/merge` — command
  // shapes that `mergeVerbArgs` does not match (they use `api`, not `merge`
  // as the verb). The doors run over the command AND over every `( … )` /
  // `$( … )` / backtick body AT EVERY DEPTH: a REST-door call inside a
  // subshell or substitution (`(gh api repos/o/r/pulls/17/merge)`,
  // `x=$(gh api repos/o/r/pulls/17/merge)`, or two levels deep,
  // `x=$(y=$(gh api repos/o/r/pulls/17/merge))`) is a live merge the guard
  // must catch, fail-closed — the same doctrine the verb door applies to
  // those bodies. `restBodyTexts` flattens the bodies recursively (the
  // same closure the verb door uses via `matchSegmentsTail`), so a merge
  // hidden in a body-inside-a-body is not missed by a missing anchor (the
  // FORGE regex's leading separator set does not include `$` or `(`, so
  // `gh` after a `$( ` in the stripped text would never anchor).
  return restDoors(restBodyTexts(command));
}

/**
 * The whole command plus the bodies of every subshell / substitution /
 * backtick construct at EVERY depth — the recursive flatten the REST doors
 * run over. Every body is a strict substring of the text that produced it,
 * so the recursion terminates on pathological input (the 50-level-nested
 * `$(…)` perf canary in test-merge-guard-955-r2.ts exercises this).
 */
function restBodyTexts(text: string): string[] {
  const out = [text];
  const bodies = innerBodies(text);
  for (const b of bodies) out.push(...restBodyTexts(b));
  return out;
}

/**
 * The REST doors, run over a list of command texts (the whole command plus
 * its `( … )` / `$( … )` / backtick bodies). Returns the matched span from
 * the FIRST text that carries a REST merge, or undefined.
 */
function restDoors(texts: string[]): string | undefined {
  for (const raw of texts) {
    // A leading unbalanced `(` (an unbalanced paren — `innerBodies` reports
    // no balanced body for it, so the REST door sees the text whole) is
    // stripped before the regex, the same coping `matchMergeVerb` applies
    // to its glued-paren token: `(gh api repos/o/r/pulls/17/merge` is a
    // live merge the guard must refuse, and the FORGE regex cannot anchor
    // `gh` after a `(` (the `(` is not in the leading separator set).
    const c = stripQuotedSegments(raw).replace(/^\s*\(/, "");
    // The forge word, optionally path-qualified (`/usr/bin/gh`) — an
    // inline copy of the forge-word fragment that the verb door keeps in
    // MERGE_VERB_SPAN_SRC (merge-tokens.ts), kept separate (and NOT
    // composed from that source) because the REST doors need an OPTIONAL
    // repo flag between the forge word and `api` (`gh -R o/r api …`) that
    // the verb span does not carry (#955 adversarial round 2, finding 1).
    // The leading separator / `oo` prefix differ between the doors, so the
    // shared fragment never composes into both as-is.
    const FORGE =
      "(?:^|[;&|]|\\s)(?:oo\\s+)?(?:/\\S*/)?(?:gh|glab)(?:\\s+(?:-R|--repo|--project)\\s+\\S+)?\\s+";
    // REST door, gh: `gh api` on /pulls/{n}/merge — gh api defaults to
    // POST/PUT when no --method is given, so the /merge suffix IS the write
    // even when it "looks like a read". The no-number `.../pulls/merge`
    // shape is the same door.
    // Arbitrary `api` flags (with or without values) before the endpoint
    // path: `gh api -X PUT repos/o/r/…`, `gh api --method PUT repos/o/r/…`.
    // The flags are allowed as any non-whitespace tokens between `api` and
    // the path; the path itself starts with `repos/` (gh) or `projects/`
    // (glab), which anchors the match.
    const ghApiMatch = new RegExp(`${FORGE}api\\s+((?:\\S+\\s+)*repos/[^\\s]+)`).exec(c);
    const ghEndpoint = ghApiMatch?.[1]?.match(/repos\/[^\s]+/)?.[0] ?? "";
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
      `${FORGE}api\\s+((?:\\S+\\s+)*?/?projects/[^\\s]+/(?:mr|merge_requests)(?:/[^\\s/?#]+)?/merge(?:[?&#\\s]|$))`,
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
function findVerbSpanInSegments(text: string): string | undefined {
  const segments = shellSegments(text);
  if (segments.length === 0) return undefined;
  for (const seg of segments) {
    const span = segmentSpanOrUnwrapped(seg);
    if (span !== undefined) return span;
    const bodies = innerBodies(seg);
    for (const body of bodies) {
      const inner = findVerbSpanInSegments(body);
      if (inner !== undefined) return inner;
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
  const m = mergeVerbSpanRegex().exec(seg);
  if (!m) return undefined;
  // The match may start with the leading separator/space — the span is
  // the forge word onward, so slice it off and trim.
  return m[0].replace(/^\s*[;&|]?\s*/, "").trim();
}
