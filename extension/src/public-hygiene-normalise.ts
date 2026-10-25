/**
 * public-hygiene-normalise — the driver's own publishes show host paths as
 * `~` and `<repo>`, not as the host's absolute paths (the #1788 follow-up).
 *
 * ## Why a rewrite and not just a refusal
 *
 * A /work handoff body is written by the driver from process memory and quoted
 * straight out of the host: a transcript path under the operator's home, a
 * worktree path, a verify log under the repository. The generic set already
 * refuses a personal home path in public text, so a handoff that names where
 * its own evidence lives was refused for naming it — and the refusal told the
 * operator to replace the path with a placeholder. This module writes that
 * placeholder: `/home/<user>/x` becomes `~/x` and the repository root becomes
 * `<repo>/…`, which is what the operator would have typed and what a reader of
 * the comment actually needs.
 *
 * ## Two orders that are not interchangeable
 *
 * **Repository roots first, longest first.** A worktree sits INSIDE the repo
 * (`.worktrees/issue-N-…`), so if the home rule ran first and the home happened
 * to be inside the tree, the shorter root would win and leave the repo half
 * rewritten. Longest-first is the same rule `work-driver-consolidation-note.ts`
 * uses for the same reason.
 *
 * **Rewriting can only ever introduce a home path, so the CHECK runs after the
 * rewrite.** Replacing `/srv/ci/runner` with `~/runner` is a rewrite that makes
 * a text newly look like a personal home directory. A check on the original
 * bytes would pass a body that the posted bytes then got refused for; checking
 * the rewritten text is what keeps "the bytes written equal the bytes judged".
 *
 * ## What is never rewritten
 *
 * - A path under ANOTHER user's home. `~` means "the home directory of whoever
 *   ran the rewrite", so `/home/other/x` may not become `~/x`: that would
 *   publish a personal path AND attribute it to the operator. The home rule
 *   therefore considers exactly the current user's home, asked of the injected
 *   environment rather than of the process, so an offline test builds its own.
 * - Anything inside a `<!-- pi-rukas: … -->` marker. Those bytes are read by
 *   `parseHandoffMarker` and `lensResidualsMarker` — the disclosure marker IS
 *   the identity the draft and merge gates compare. They are asserted
 *   byte-identical by test-public-hygiene-normalise.ts.
 * - A path under a DIFFERENT repository root (another clone, another host's
 *   tree). Nothing here is a redaction of secrets: the denylist check still
 *   runs after the rewrite, fail-closed, and refuses what it refused before.
 */

import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A path segment that cannot continue a path: what must follow a root. */
const PATH_BREAK = /[^A-Za-z0-9._~+-]/;

/**
 * What makes the character AFTER a root part of a longer name. A word
 * character continues it outright; `-` and `.` do too, because they are exactly
 * what distinguishes the sibling directory `/srv/myrepo-backup` from the root
 * `/srv/myrepo` — rewriting that would claim a path no reader could resolve.
 */
const PATH_WORD = /[A-Za-z0-9_]/;
const CONTINUES_NAME = /[-.]/;

/** The marker spans whose bytes a rewrite may not touch. */
const MARKER = /<!--\s*pi-rukas:.*?-->/gs;

/** What one rewrite did — enough for the trace, never the rewritten text. */
export type NormaliseKind = "repo" | "home";

/** The outcome: the bytes to publish, and whether they differ from the input. */
export interface NormaliseResult {
  text: string;
  /** True when at least one absolute root was replaced. */
  rewritten: boolean;
  /** Which kinds of root were replaced, in the order the rewrites ran. */
  kinds: NormaliseKind[];
}

/** The sentence the handoff carries when its paths were rewritten. */
export const PATH_NORMALISATION_NOTE =
  "Paths are shown relative to `~` (the home directory) and `<repo>` (the repository root) of the host that ran this cycle.";

/**
 * Append the normalisation note to a handoff body, once and only when a rewrite
 * happened. Idempotent, because a handoff body is rendered, written, and may be
 * re-read and re-posted (the in-process fallback), and a body that grew the
 * note on every pass would say it twice.
 */
export function withPathNormalisationNote(body: string, rewritten: boolean): string {
  if (!rewritten) return body;
  if (body.includes(PATH_NORMALISATION_NOTE)) return body;
  return `${body.replace(/\s+$/, "")}\n\n${PATH_NORMALISATION_NOTE}\n`;
}

/**
 * Rewrite the repository-root and home-directory paths in a driver-composed
 * publish out of it.
 *
 * `roots` are the repository spellings to collapse — the configured root and its
 * realpath. `home`, when supplied, is the current user's home in both spellings;
 * the caller derives it through {@link normaliseDriverPublishPaths} so a test can
 * hand in a scratch home instead of the machine's. A root that is not a non-empty
 * string — missing, empty, or a non-string that reached the caller as data — is
 * skipped rather than matched, and never turns the rewrite into a no-op for the
 * roots that WERE supplied.
 */
export function normalisePublishPaths(
  text: string,
  roots: readonly (string | undefined)[],
  home?: readonly (string | undefined)[],
): NormaliseResult {
  if (text === "") return { text, rewritten: false, kinds: [] };
  const repo = spellings(roots);
  const userHome = spellings(home ?? []);
  if (repo.length === 0 && userHome.length === 0) return { text, rewritten: false, kinds: [] };
  // The markers are masked out before any rewrite and put back verbatim after,
  // so a marker can never be rewritten even when it names a path. A control
  // character no publish body carries is the mask; if one ever did appear, the
  // rewrite is skipped for the whole text rather than applied inside a marker.
  const spans = markers(text);
  const masked = maskMarkers(text, spans);
  if (masked === undefined) return { text, rewritten: false, kinds: [] };
  let out = masked;
  const kinds: NormaliseKind[] = [];
  const record = (next: string, kind: NormaliseKind): string => {
    if (next !== out) kinds.push(kind);
    return next;
  };
  for (const root of repo) out = record(replaceRoot(out, root, "<repo>"), "repo");
  for (const root of userHome) out = record(replaceRoot(out, root, "~"), "home");
  return {
    text: unmaskMarkers(out, spans),
    rewritten: kinds.length > 0,
    kinds,
  };
}

/** One control character outside every publish body: the mask for a marker. */
const MASK = "\u0001";

/** Replace each marker span with the mask, or refuse when the mask is present. */
function maskMarkers(
  text: string,
  spans: readonly { start: number; end: number }[],
): string | undefined {
  if (text.includes(MASK)) return undefined;
  let out = "";
  let from = 0;
  for (const s of spans) {
    out += text.slice(from, s.start) + MASK;
    from = s.end;
  }
  return out + text.slice(from);
}

/** Put each marker back, in order, over the masks that replaced it. */
function unmaskMarkers(
  text: string,
  spans: readonly { start: number; end: number; raw: string }[],
): string {
  if (spans.length === 0) return text;
  let out = "";
  let i = 0;
  for (const s of spans) {
    const at = text.indexOf(MASK, i);
    if (at < 0) return text;
    out += text.slice(i, at) + s.raw;
    i = at + MASK.length;
  }
  return out + text.slice(i);
}

/**
 * The rewrite every driver-side publish check applies, with the roots derived
 * from the caller's knowledge: the repository root it is publishing from and its
 * realpath, and the current user's home and its realpath. A cycle's worktrees sit
 * under the repository root, so the root's spelling already covers them. Each
 * spelling is looked up best-effort — a root that cannot be stat'd has
 * nothing further to rewrite, exactly as in `consolidationNote`.
 *
 * `homeDir` and `realpath` are seams for the offline suite, which builds its
 * own scratch home and repository trees and must never rewrite (or read) the
 * host's. With none supplied the function asks `os.homedir()` / `realpathSync`.
 * A `realpath` that throws means "no second spelling", the same as the failure
 * of the real lookup.
 */
export function normaliseDriverPublishPaths(
  text: string,
  opts: {
    repoRoot?: string;
    homeDir?: string;
    realpath?: (dir: string) => string;
  },
): NormaliseResult {
  const realpath = opts.realpath ?? realpathOf;
  const roots: string[] = [];
  if (isUsableRoot(opts.repoRoot)) {
    roots.push(opts.repoRoot, ...realpathsOf(opts.repoRoot, realpath));
  }
  const home = opts.homeDir ?? homeFromEnv();
  return normalisePublishPaths(
    text,
    roots,
    isUsableRoot(home) ? [home, ...realpathsOf(home, realpath)] : [],
  );
}

/** A root this rewrite can act on: a string, non-empty after trimming. */
function isUsableRoot(dir: unknown): dir is string {
  return typeof dir === "string" && dir.trim() !== "";
}

/** The current user's home as the process knows it (an env `HOME` wins). */
function homeFromEnv(): string {
  const fromEnv = process.env.HOME?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : os.homedir();
}

/** Trim, de-duplicate, drop separators, and sort longest-first. */
function spellings(dirs: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!isUsableRoot(dir)) continue;
    const trimmed = withoutSeparator(dir);
    if (trimmed !== "" && path.isAbsolute(trimmed)) seen.add(trimmed);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/** A root's realpath alongside it, when the filesystem can name one. */
function realpathsOf(dir: string, realpath: (dir: string) => string): string[] {
  try {
    const real = realpath(dir);
    return real === dir ? [] : [real];
  } catch {
    return [];
  }
}

/** The filesystem's own realpath. */
function realpathOf(dir: string): string {
  return realpathSync(dir);
}

/**
 * Replace every occurrence of `root` used AS a path — one that starts at a
 * boundary and ENDS there, i.e. is followed by a path separator or by anything
 * that cannot continue its name — with `placeholder`. A root that merely
 * PRECEDES other text (`/srv/myrepo-backup` for a root of `/srv/myrepo`, or
 * `/srv/myrepo.old`) is not a path under that root and is left alone: rewriting
 * it would claim a path that does not exist under the repository, and a reader
 * could not resolve it.
 *
 * ## Why a trailing separator is not the only terminator
 *
 * A root that ends a WORD also ends a path: `git status in /home/me/repo: fatal
 * to run` and a markdown close-tick after the path both name the root itself,
 * with nothing but punctuation after it. Requiring a `/` there did not keep
 * anything safe — it just left the root standing. And leaving it standing is
 * what BROKE a handoff: the fold only rewrites roots it recognises, so an
 * unfolded repository root that sits inside the operator's home keeps the host
 * home visible in the very text the denylist check then refuses for naming a
 * personal directory — a handoff the driver rendered and could not publish
 * (#1820). The sibling-root rule is untouched: a root followed by more word
 * characters is a DIFFERENT directory and still never matches.
 */
function replaceRoot(text: string, root: string, placeholder: string): string {
  if (root === "" || !text.includes(root)) return text;
  let out = "";
  let from = 0;
  let cursor = text.indexOf(root, from);
  while (cursor >= 0) {
    const beforeOk = cursor === 0 || PATH_BREAK.test(text[cursor - 1] as string);
    const after = cursor + root.length;
    const next = text[after];
    // `next === undefined` — the root ended the text — and `next === "/"` — a
    // path under it — were both accepted. A root followed by PUNCTUATION was
    // not, and that was wrong: `… in /home/me/repo: fatal` names the root
    // itself, so requiring a separator left it standing (#1820). But `-` and `.`
    // are what make `/srv/myrepo-backup` and `/srv/myrepo.old` a DIFFERENT
    // directory than `/srv/myrepo`, and the rule's whole purpose is not to
    // rewrite those. So the character after the root must neither continue the
    // root's name (a word character, `-` or `.`) nor be a path separator.
    const afterOk = next === undefined || !(PATH_WORD.test(next) || CONTINUES_NAME.test(next));
    if (beforeOk && afterOk) {
      out += text.slice(from, cursor) + placeholder;
      from = after;
      cursor = text.indexOf(root, from);
      continue;
    }
    out += text.slice(from, cursor + root.length);
    from = cursor + root.length;
    cursor = text.indexOf(root, from);
  }
  return out + text.slice(from);
}

/** The `<!-- pi-rukas: … -->` spans of a body, in source order. */
function markers(text: string): { start: number; end: number; raw: string }[] {
  const spans: { start: number; end: number; raw: string }[] = [];
  MARKER.lastIndex = 0;
  for (const m of text.matchAll(MARKER)) {
    if (m.index === undefined || m[0] === undefined) continue;
    spans.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  return spans;
}

/** A trailing path separator dropped, so `<repo>//x` never appears. */
function withoutSeparator(dir: string): string {
  if (dir.length > 1 && dir.endsWith("/")) return dir.replace(/\/+$/, "");
  return dir;
}
