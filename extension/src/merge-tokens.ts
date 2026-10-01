/**
 * merge-tokens — the shared token walk behind the merge guard's matcher
 * (#912) and its PR-number/repo extraction (#955). Split out of merge-parse.ts
 * (which sat at the 500-line §12 limit) along the tokenizer seam: everything
 * that reads a raw command into tokens, or reads one command's segments,
 * lives here; merge-parse.ts keeps the merge-verb matching and argument
 * parsing and imports the walk from here.
 *
 * The quote model is the same everywhere in this module: single-quoted runs
 * are literal, double-quoted runs allow backslash escapes (the inner `\`
 * survives so an inner `\"` is recognisable by the segment walker), and
 * ANSI-C / anishi `$'…'` strings are handled too. An unterminated quote makes
 * the walk report `terminated: false` — the caller fails closed.
 */

/**
 * The raw-command token walk used by the merge-verb unwrapping and the
 * post-verb argument parser: quoted runs are kept as a single token WITH
 * their outer quotes (so the reader can strip them); separators are their
 * own tokens. `terminated` is false when a quote never closes — the caller
 * treats that as "unparseable" (fail-closed upstream).
 *
 * Handles single-quoted ('…'), double-quoted ("…" with backslash escapes),
 * and ANSI-C / anishi-quoted ($'…') strings.
 */
export function rawTokens(raw: string): { list: string[]; terminated: boolean } {
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
    // Anishi / ANSI-C quoting: $'…'
    if (ch === "$" && (raw[i + 1] ?? "") === "'") {
      i += 2;
      let closed = false;
      let buf = "";
      while (i < n) {
        const c2 = raw[i] ?? "";
        if (c2 === "\\" && i + 1 < n) {
          const nx = raw[i + 1] ?? "";
          buf +=
            nx === "n" ? "\n" : nx === "t" ? "\t" : nx === "\\" ? "\\" : nx === "'" ? "'" : c2 + nx;
          i += 2;
          continue;
        }
        if (c2 === "'") {
          closed = true;
          i++;
          break;
        }
        buf += c2;
        i++;
      }
      if (!closed) return { list, terminated: false };
      list.push(`$'${buf}'`);
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

/**
 * The merge-verb-locating regex source — the ONE copy of the pattern that
 * locates the matched verb span inside a segment (the optional leading
 * separator, the optionally path-qualified forge word, an optional
 * `-R`/`--repo`/`--project` value, and the `pr merge` / `mr merge` verb).
 *
 * #955 lens fix 4: this pattern was duplicated in three modules
 * (bash-merge-pr.ts's segmentVerbSpan, merge-parse.ts's matchSegmentsTail
 * and merge-wrappers.ts). It now lives here — the leaf module of the merge
 * guard — and the anchored variant is built from this same string at the
 * one site that needs anchoring (the verb-HEAD test in merge-wrappers.ts).
 * All consumers share the source, so the pattern can never drift between
 * the matcher (bash-merges-pr.ts), the argument-tail extractor (merge-
 * parse.ts) and the verb-head matcher (merge-wrappers.ts).
 */
export const MERGE_VERB_SPAN_SRC = String.raw`(?:^|[\s;&|])(?:/\S*\/)?(?:gh|glab)(?:\s+(?:-R|--repo|--project)\s+\S+)?\s+(?:pr|mr)\s+merge\b`;

/**
 * The forge-prefix source — the (optionally path-qualified) forge word
 * fragment shared by the REST doors in bash-merges-pr.ts. The leading
 * separator and the `oo` prefix stay in the consumer (they differ between
 * the verb span and the REST doors).
 */
export const FORGE_PREFIX_SRC = String.raw`(?:/\S*\/)?(?:gh|glab)\s+`;

/** The verb span as a fresh RegExp (re-compiled at every use — stateless). */
export function mergeVerbSpanRegex(): RegExp {
  return new RegExp(MERGE_VERB_SPAN_SRC);
}

/** The anchored verb-source (the verb-HEAD test in merge-wrappers.ts). */
export function mergeVerbHeadRegex(): RegExp {
  return /^(?:gh|glab|\S*\/(?:gh|glab))\s+(?:-R\s+\S+|--repo\s+\S+|--project\s+\S+)?\s*(?:pr|mr)\s+merge(?:\s|$)/;
}

/**
 * The strict repo-value pattern: one or more segments of alphanumerics,
 * dots, underscores and hyphens separated by slashes. GitLab allows
 * subgroups (`group/sub/project`), so 2+ segments is required (a bare
 * `owner` without a slash is not a valid repo).
 *
 * #955 lens fix 1 (HIGH): the repo value is parsed from the agent's
 * `-R`/`--repo`/`--project` flags or a PR URL and was interpolated directly
 * into the exec strings in merge-target.ts. A value like `o/r; touch /tmp/x`
 * would execute arbitrary commands. The guard validates it here (at the
 * extraction site in merge-parse.ts) AND defensively in merge-target.ts
 * before use; an invalid value fails closed — the guard refuses with
 * "unsafe repo value" and never interpolates it.
 */
export const REPO_VALUE_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;

/**
 * Whether a raw repo value is safe to interpolate into a forge exec string.
 * See `REPO_VALUE_PATTERN` for the pattern and rationale.
 */
export function isValidRepoValue(value: string): boolean {
  return REPO_VALUE_PATTERN.test(value);
}

/**
 * Strip the outer quotes from a quoted token and unescape double-quote
 * escapes (\" → ", \\ → \). Single-quoted tokens are returned verbatim
 * (no escape sequences in bash single quotes).
 */
export function unquoteArg(arg: string): string {
  if (arg.startsWith("$'")) return arg.slice(2, -1);
  const q = arg[0];
  if (q === "'") return arg.slice(1, -1);
  // Double-quoted: unescape \" → " and \\ → \
  let out = "";
  for (let i = 1; i < arg.length - 1; i++) {
    const c = arg[i] ?? "";
    if (c === "\\" && i + 1 < arg.length - 1) {
      const next = arg[i + 1] ?? "";
      if (next === '"' || next === "\\") {
        out += next;
        i++;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * The command's shell segments — the raw substrings between top-level `;`,
 * `&&` and `|` separators (quote-aware: a `|` inside a quoted argument is
 * data, not a separator). A trailing bare `&` (job control, `nohup gh pr
 * merge 17 &`) terminates the command the same way those separators do — the
 * following text is a NEW command (or none), so it gets its own segment (the
 * bare `&` itself is not part of either segment; `parseArgsAfterVerb` trims
 * a trailing `&` off the verb tail it consumes, so the number still parses
 * either way). Used to match each segment's head against
 * `merge-verb-head.ts`'s wrapper-stripped command regex, the way the
 * quote-stripped matcher scans the whole command.
 */
export function shellSegments(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let i = 0;
  const n = command.length;
  let closed = true;
  while (i < n) {
    const ch = command[i] ?? "";
    if (ch === "'" || ch === '"') {
      const q = ch;
      const start = i;
      i++;
      let found = false;
      while (i < n) {
        if (q === '"' && command[i] === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (command[i] === q) {
          found = true;
          i++;
          break;
        }
        i++;
      }
      if (!found) {
        closed = false; // unterminated quote — the caller fails closed
        break;
      }
      cur += command.slice(start, i);
      continue;
    }
    if (ch === ";" || ch === "|" || (ch === "&" && (command[i + 1] ?? "") === "&")) {
      parts.push(cur);
      cur = "";
      i += ch === "&" ? 2 : 1;
      continue;
    }
    // A bare `&` (not `&&`) ends the current command — job control. It is
    // not part of the command; the next text is its own segment.
    if (ch === "&") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (closed) parts.push(cur);
  return parts;
}
