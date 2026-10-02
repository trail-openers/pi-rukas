import { mergeVerbArgs } from "./merge-parse.ts";
import { exceedsAnalysisBound } from "./merge-size.ts";
import {
  MAX_CONSTRUCT_DEPTH,
  mergeVerbSpanRegex,
  rawTokens,
  shellSegments,
  unquoteArg,
} from "./merge-tokens.ts";
import { innerBodies, matchMergeVerb, mergeVerbUnwrapOne } from "./merge-verb-head.ts";
import { skipLeadingWrappers } from "./merge-wrappers.ts";

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
  // #955 (perf): size bound for merge-bearing commands — the constant and
  // the measured rationale live in merge-size.ts. The guard (merge-guard.ts)
  // checks `exceedsAnalysisBound` FIRST and refuses such a command with an
  // explicit "too large to analyse" reason, so this branch is the matcher's
  // own fail-closed span (a merge with no resolvable number — never a clean
  // pass) for the same shapes, keeping the matcher honest on its own even
  // if called outside the hook.
  if (exceedsAnalysisBound(command)) {
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
    const span = findVerbSpanInSegments(command, MAX_CONSTRUCT_DEPTH);
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
  return restDoors(restBodyTexts(command, MAX_CONSTRUCT_DEPTH));
}

/**
 * The whole command plus the bodies of every subshell / substitution /
 * backtick construct up to `depth` levels (the `MAX_CONSTRUCT_DEPTH`
 * budget) — the recursive flatten the REST doors run over. The recursion
 * terminates for any input: every body is a strict substring of the text
 * that produced it (no exponential blowup), and `depth` decrements per
 * level — past the ceiling the flatten simply stops descending, which is
 * a lossless fail-closed signal for the REST doors (a merge hidden past
 * the ceiling has already been refused by the verb door above, which walks
 * the same bodies under the same budget and returns its fail-closed
 * span). The bound is what keeps a 20000-level nested-substitution
 * command from overflowing the JS call stack; the 50-level-nested `$(…)`
 * REST canary in test-merge-guard-955-r2.ts sits far under the ceiling
 * and is analysed unchanged.
 */
function restBodyTexts(text: string, depth: number): string[] {
  const out = [text];
  const bodies = innerBodies(text);
  for (const b of bodies) {
    out.push(...restBodyTexts(b, depth <= 0 ? 0 : depth - 1));
  }
  return out;
}

/**
 * The REST doors, run over a list of command texts (the whole command plus
 * its `( … )` / `$( … )` / backtick bodies). Returns the matched span from
 * the FIRST text that carries a REST merge, or undefined.
 */
function restDoors(texts: string[]): string | undefined {
  for (const raw of texts) {
    const hit = restDoorTokens(raw);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * The REST doors on ONE command text's raw tokens (quote-aware walk, no
 * quote-stripping — #955 lens round 6: the REST endpoint is matched among
 * the UNQUOTED tokens, because the shell removes quotes around a whole word
 * before execution — `gh api -X PUT "repos/o/r/pulls/17/merge"` is a live
 * merge with the endpoint quoted, and the old `stripQuotedSegments` path
 * deleted the endpoint before the regex could see it).
 *
 * A REST merge is recognised only when a segment's COMMAND WORD (after
 * `skipLeadingWrappers`, unquoted — the same wrapper vocabulary the verb
 * door uses, so `oo gh api …` / `timeout 30 gh api …` match) is `gh`/`glab`
 * and the next unquoted token is `api`. Quoting a whole word is what the
 * shell does, so the words are unquoted — but a quoted STRING that is one
 * token (the endpoint of `echo "gh api …/merge"`) is NOT a command word
 * (the command word is `echo`) and the endpoint scan only runs over the
 * `api` argument list (from the unquoted `api` token onward), so quoted
 * non-merge shapes stay inert exactly the way the verb door's quoted shapes
 * do.
 *
 * The existing method/fields logic then applies to the UNQUOTED tokens from
 * the command word onward: `gh api` defaults to POST/PUT (so the
 * `/pulls/N/merge` endpoint alone is the write; `--method GET` without
 * body fields stays a read), `glab api` is method-aware (only an explicit
 * PUT/POST or a body field is the write).
 */
function restDoorTokens(text: string): string | undefined {
  const tokens = rawTokens(text);
  if (tokens.terminated === false) return undefined;
  const list = tokens.list;
  // A leading unbalanced `(` (an unbalanced paren — `innerBodies` reports
  // no balanced body for it, so the REST door sees the text whole) is
  // stripped before matching, the same coping the old quote-stripped path
  // applied: `(gh api repos/o/r/pulls/17/merge` is a live merge the guard
  // must refuse. `rawTokens` glues the paren to the next word, so it lands
  // on the first token (`(gh`) — strip it there.
  if (list.length > 0) {
    const first = unquoteArg(list[0] ?? "");
    if (first.startsWith("(")) {
      const stripped = first.replace(/^\(/, "");
      list[0] = stripped.length > 0 ? stripped : "";
    }
  }
  const n = list.length;
  const isSep = (t: string) => t === ";" || t === "&&" || t === "||" || t === "|";
  for (let i = 0; i < n; i++) {
    if (i > 0 && !isSep(unquoteArg(list[i - 1] ?? ""))) continue;
    // The segment's unquoted tokens, up to the next separator.
    // #955 round 1 fix: bash concatenates adjacent quoted + bare runs into
    // one word, so a REST endpoint split across quote boundaries
    // ("repos/o/r/pulls/17"/merge, repos/o/r/pulls/"17"/merge)
    // arrives as multiple raw tokens. The unquoted forms are merged
    // below: a token is a path continuation of the previous token when
    // (a) it starts with `/` (a bare path segment like "/merge"), OR
    // (b) the previous token ends with `/` and this token does not start
    //     with `-` (a path value like `17` following `…/pulls/`).
    // Without this merge, the endpoint regex sees only the first fragment
    // and the /merge suffix is lost — a live merge passes the guard.
    const seg: string[] = [];
    let j = i;
    while (j < n && !isSep(unquoteArg(list[j] ?? ""))) {
      const s = unquoteArg(list[j] ?? "");
      if (s !== "") {
        const prev = seg[seg.length - 1];
        // A token is a path continuation of the previous token when:
        // (a) the previous token is a path fragment (contains `/` and is
        //     not a flag) and this token starts with `/` — a bare path
        //     segment like `/merge` following `…/pulls/17`;
        // (b) the previous token ends with `/` (a path prefix like
        //     `…/pulls/`) and this token does not start with `-` — a
        //     path value like `17` following `…/pulls/`.
        // The key guard: condition (a) requires the previous token to
        // already be a path fragment, so `PUT /projects/…` (a flag value
        // followed by a path) does NOT merge — `PUT` is not a path.
        const prevIsPath = prev !== undefined && !prev.startsWith("-") && prev.includes("/");
        const isContinuation =
          (s.startsWith("/") && prevIsPath) || (prev?.endsWith("/") === true && !s.startsWith("-"));
        if (isContinuation) {
          // Path continuation: bash concatenated this quoted/bare run
          // with the previous word (e.g. "…pulls/17" + "/merge" →
          // "…pulls/17/merge", or "…/pulls/" + "17" → "…/pulls/17").
          seg[seg.length - 1] = prev + s;
        } else {
          seg.push(s);
        }
      }
      j++;
    }
    // The command word: skip the leading wrappers the same way the verb
    // door does (the walk has already unquoted every token, so
    // `skipLeadingWrappers` only sees bare words).
    const ci = skipLeadingWrappers(seg, 0);
    const cmd = seg[ci] ?? "";
    const cmdBase = cmd.includes("/") ? (cmd.split("/").pop() ?? "") : cmd;
    if (cmdBase !== "gh" && cmdBase !== "glab") continue;
    // The `api` verb: the first token after the command word that is `api`
    // (the tokens before it are the repo flag + its value — `gh -R o/r api
    // …`, #955 adversarial round 2 finding 1 — which the old FORGE regex
    // carried as an optional group and the token walk must skip the same
    // way).
    const ai = seg.indexOf("api", ci + 1);
    if (ai === -1) continue;
    const args = seg.slice(ai + 1);
    const endpoint = restEndpointToken(args);
    if (endpoint === undefined) continue;
    const all = seg.slice(ci).join(" ");
    if (cmdBase === "gh") {
      // REST door, gh: `gh api` on /pulls/{n}/merge — gh api defaults to
      // POST/PUT when no --method is given, so the /merge suffix IS the write
      // even when it "looks like a read". The no-number `.../pulls/merge`
      // shape is the same door.
      // The door is a WRITE unless the command is an explicit GET AND carries
      // no body fields — gh api's `-f`/`-F`/`--field` flags force a PUT
      // regardless of `--method`, so `--method GET --field x` is still the write.
      if (!/\/pulls(?:\/[^\s/?#]+)?\/merge(?:[?&#]|$)/.test(endpoint)) continue;
      const explicitGet = /(^|\s)(?:--method|-X)\s+get\b/i.test(all);
      const hasBodyFields = /(^|\s)(?:-f|-F|--field)(?:=|\s)/.test(all);
      if (!explicitGet || hasBodyFields) return `${cmd} api ${endpoint}`;
    } else {
      // REST door, glab: `glab api` on /mr/{n}/merge or
      // /merge_requests/{n}/merge (the repo's canonical shape) — method-AWARE:
      // blocked only when the command EXPLICITLY writes (glab api does not
      // default to POST the way gh api does; copying the gh rule here would
      // over-block legitimate reads). Method names are case-insensitive.
      if (!/\/(?:mr|merge_requests)(?:\/[^\s/?#]+)?\/merge(?:[?&#]|$)/.test(endpoint)) continue;
      const explicitGet = /(^|\s)(?:--method|-X)\s+get\b/i.test(all);
      const writes =
        /(^|\s)(?:-X|-f|-F)\s+(?:put|post)\b/i.test(all) ||
        /(^|\s)--method\s+(?:put|post)\b/i.test(all) ||
        /(^|\s)(?:-f|-F|--field)(?:=|\s)/.test(all);
      if (!explicitGet && writes) return `${cmd} api ${endpoint}`;
    }
  }
  return undefined;
}

/**
 * The endpoint token among a forge `api` argument list (the unquoted
 * tokens after `api`, leading flags skipped): the first token that is a
 * `repos/…` (gh) or `/…projects/…` (glab) path. `undefined` when the
 * argument list carries no such token (a non-REST `api` call, or a read on
 * a different path). A flag that takes a value consumes the token after
 * it, so a value that merely LOOKS like a path is never read as the
 * endpoint (`-X repos/o/r/…` — the `-X` value is skipped, the next token
 * is the real endpoint).
 */
function restEndpointToken(args: string[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const t = args[k] ?? "";
    if (/^repos\//.test(t)) return t;
    if (/^\/?.*projects\//.test(t)) return t;
    if (t.startsWith("-") && !t.includes("=")) {
      // A flag that takes a value: `--method`/`-X` (the token after it is
      // the method), the repo flags, and short flags generally take a
      // value; skip it.
      // The long repo/project flags (`--repo`, `--project`) are the
      // exception: in REST-door form (`gh --repo o/r api …`) they carry
      // the repo, NOT a flag value, so they must NOT skip the next token
      // (skipping it would eat the endpoint — the #955 adversarial-round-2
      // finding-1 shape `gh -R o/r api …` failing to match).
      const shortTakesValue = t.length === 2;
      const longTakesValue = t === "--method" || t === "-X";
      if (longTakesValue || shortTakesValue) k++;
    }
  }
  return undefined;
}

/**
 * Find the matched verb span in the first segment (or nested inner body)
 * whose head matches `matchMergeVerb`. Recurses into `( … )` / `$( … )` /
 * backtick bodies the same way `mergeVerbArgs` does, under the same
 * `MAX_CONSTRUCT_DEPTH` budget. The recursion terminates and is bounded:
 * every body is a strict substring of the text that produced it (no
 * exponential blowup), and `depth` decrements per level — past the ceiling
 * the walk simply returns undefined (no span). The caller (`mergesPr`)
 * already knows the verb door matched (it only calls this after
 * `mergeVerbArgs` returned non-undefined) and fails closed with the
 * minimal `"gh pr merge"` span when no span is found — including the
 * past-the-ceiling case — so an undefined return here can never read as
 * "not a merge".
 */
function findVerbSpanInSegments(text: string, depth: number): string | undefined {
  const segments = shellSegments(text);
  if (segments.length === 0) return undefined;
  for (const seg of segments) {
    const span = segmentSpanOrUnwrapped(seg);
    if (span !== undefined) return span;
    const bodies = innerBodies(seg);
    if (depth <= 0) continue; // budget exhausted — no span (the caller fails closed)
    for (const body of bodies) {
      const inner = findVerbSpanInSegments(body, depth - 1);
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
