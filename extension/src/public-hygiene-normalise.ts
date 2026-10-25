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
 * `roots` are the repository spellings to collapse — the configured root, its
 * realpath, and this cycle's worktree when that differs. `home`, when supplied,
 * is the current user's home in both spellings; the caller derives it through
 * {@link normaliseDriverPublishPaths} so a test can hand in a scratch home
 * instead of the machine's. A missing or empty spelling is skipped rather than
 * matched.
 */
export function normalisePublishPaths(
  text: string,
  roots: readonly string[],
  home?: readonly string[],
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
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    realpath?: (dir: string) => string;
  },
): NormaliseResult {
  const realpath = opts.realpath ?? realpathOf;
  const roots: string[] = [];
  if (opts.repoRoot !== undefined && opts.repoRoot !== "") {
    roots.push(opts.repoRoot, ...realpathsOf(opts.repoRoot, realpath));
  }
  const home = opts.homeDir ?? homeFromEnv(opts.env ?? process.env);
  return normalisePublishPaths(
    text,
    roots,
    home === "" ? [] : [home, ...realpathsOf(home, realpath)],
  );
}

/** The current user's home as the process knows it (an env `HOME` wins). */
function homeFromEnv(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HOME?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : os.homedir();
}

/**
 * The current user's home, in both spellings — `os.homedir()` and its realpath.
 *
 * The environment is consulted for `HOME` only when it is the caller's own
 * (tests pass one); production passes nothing and `os.homedir()` answers, which
 * is the same value `public-denylist.ts` builds the default list path from.
 */
export function homeSpellings(env: NodeJS.ProcessEnv = process.env): string[] {
  return spellings([homeFromEnv(env)]);
}

/** Trim, de-duplicate, drop separators, and sort longest-first. */
function spellings(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (dir === undefined) continue;
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
 * boundary and is followed by `/` or is at the end of the text — with
 * `placeholder`. A root that merely PRECEDES other text (`/srv/myrepo-backup`
 * for a root of `/srv/myrepo`, or `/srv/myrepo.old`) is not a path under that
 * root and is left alone: rewriting it would claim a path that does not exist
 * under the repository, and a reader could not resolve it.
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
    const afterOk = next === undefined || next === "/";
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
