import os from "node:os";
import path from "node:path";
import type { ClaimVerification } from "./research-types.ts";
/**
 * research-verify-classify — content-based driver-side source classification
 * (the #894 classifier): resolveSourcePart, splitCompoundSource,
 * checkLocalFile, parseCodeSource, groundCodeSource, checkPart.
 *
 * The child's sourceKind stays the raw record on the claim; these functions
 * derive the effective kind from the source CONTENT (an https URL the
 * child labelled "code" is still a URL; a local path labelled "url" is
 * stat-checked, never fetched).
 */
import type { StatLike } from "./research-verify.ts";
import type { ExecFn } from "./worktree.ts";

export interface ResolvedSource {
  kind: "url" | "code" | "local" | "external-code" | "doc";
  /** The URL liveness-checked for url / external-code parts. */
  url?: string;
  /** The repo-relative path for code parts. */
  path?: string;
  /** The path stat-checked for local parts. */
  localPath?: string;
  /** Set when an external-code part has no URL that can be formed. */
  externalUnchecked?: boolean;
}

/**
 * Resolve one source part by CONTENT (the driver-side classifier — the
 * child's sourceKind is never consulted): an http(s) URL → url; an
 * external repo (github blob/tree URL, or `owner/repo @ ref`) →
 * external-code (liveness-checked through a formed github URL where one
 * exists, otherwise unchecked with the "external repo" reason); a path in
 * the repo → code; an absolute, `~`- or `./`-relative path outside it →
 * local; anything else (doc references, version strings) → doc. A github
 * blob/tree URL is external-code, not plain url.
 */
export function resolveSourcePart(raw: string, repoRoot: string): ResolvedSource {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    if (
      /^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\/|^https?:\/\/github\.com\/[^/]+\/[^/]+\/tree\//i.test(
        s,
      )
    )
      return { kind: "external-code", url: s };
    return { kind: "url", url: s };
  }
  const ref = s.match(/^(\w[\w.-]*)\/(\w[\w.-]*)\s+@\s*[\w.-]+$/);
  if (ref) return { kind: "external-code", externalUnchecked: true };
  if (s.startsWith("~")) return { kind: "local", localPath: path.join(os.homedir(), s.slice(1)) };
  if (s.startsWith("./") || s.startsWith("/")) {
    if (path.isAbsolute(s)) {
      if (path.resolve(s).startsWith(`${repoRoot}/`))
        return { kind: "code", path: path.relative(repoRoot, path.resolve(s)) };
      return { kind: "local", localPath: s };
    }
    const resolved = path.resolve(repoRoot, s);
    if (resolved.startsWith(`${repoRoot}/`))
      return { kind: "code", path: path.relative(repoRoot, resolved) };
    return { kind: "local", localPath: resolved };
  }
  // A bare multi-segment word path is code ONLY with a known file
  // extension (the "lib@1.2 docs", "lib/docs" and "owner/repo" shapes must
  // stay doc, not code). Extensionless bare paths are doc references.
  const codeCandidate = s.replace(/\s*\([^()]*\)$/, "").trim();
  if (
    /^[\w@.#-]+\/[\w@.#/-]+$/.test(codeCandidate) &&
    codeCandidate.split("/").length <= 4 &&
    /\.[A-Za-z0-9]{1,10}(\.[A-Za-z0-9]{1,10})*(#\w+)?$/.test(
      codeCandidate.replace(/\s*\([^()]*\)$/, ""),
    )
  )
    return { kind: "code", path: s };
  return { kind: "doc" };
}

/**
 * Split a compound source into parts. Only `;`, ` + `, `,` and whitespace
 * BETWEEN url-like parts split — a parenthetical annotation ("… (label: …)")
 * stays with the part before it, and a source with at most one url-like
 * token is single. A doc-ish part is kept verbatim so its kind is recorded.
 */
export function splitCompoundSource(source: string): string[] {
  const urls = [...source.matchAll(/https?:\/\/\S+/g)]
    .map((m) => m[0])
    .filter((t) => /^https?:\/\//i.test(t));
  if (urls.length <= 1) return [source.trim()];
  const parts = urls.map((u, i) => {
    const trimmed = u.replace(/[\s;,+]+$/, "");
    const idx = source.indexOf(u);
    const before = source.slice(0, idx);
    // For the first part: the annotation (if any) is AFTER it, not before.
    if (i === 0) {
      const after = source.slice(idx + u.length);
      const parenStart = after.indexOf("(");
      if (parenStart >= 0) {
        let depth = 0;
        let end = -1;
        for (let k = parenStart; k < after.length; k++) {
          if (after[k] === "(") depth++;
          else if (after[k] === ")") {
            depth--;
            if (depth === 0) {
              end = k;
              break;
            }
          }
        }
        if (end >= 0) return `${trimmed} ${after.slice(parenStart, end + 1)}`;
      }
      return trimmed;
    }
    // For subsequent parts: the annotation (if any) is in `before`.
    const m = before.match(/\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$/);
    if (m) return trimmed + m[0].replace(/\s*[;,+]+$/, "");
    return trimmed;
  });
  return parts.length > 0 ? parts : [source.trim()];
}

/**
 * Stat-check one local path (injectable seam): a directory or file counts
 * as `local-present`; a missing leaf (or missing parent) is
 * `local-missing`. Local paths are NEVER fetched.
 */
export async function checkLocalFile(
  p: string,
  statFn: StatLike,
): Promise<"local-present" | "local-missing"> {
  const s = await statFn(p);
  return s ? "local-present" : "local-missing";
}

/**
 * Parse one code source part into a (path, symbol) pair. Accepted forms:
 * `path`, `path#symbol`, `path:line`, `path#Lline`, `path (annotation)`
 * and `path … line ~N` (the `#` in `L123` / `~123` is consumed as a line
 * marker, not a symbol separator).
 */
export function parseCodeSource(source: string): { path: string; symbol: string | null } {
  let s = source.trim();
  const lineTail = s.match(/^\s*(.*)\s+[\s…]+line\s*~\d+\s*$/i);
  if (lineTail?.[1]) s = lineTail[1];
  const paren = s.match(/^\s*(.*)\s*\([^()]*\)\s*$/);
  if (paren?.[1]) s = paren[1];
  let hash: string | null = null;
  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) {
    hash = s.slice(hashIdx + 1);
    s = s.slice(0, hashIdx);
  }
  let colon: string | null = null;
  const colonIdx = s.indexOf(":");
  if (colonIdx >= 0) {
    colon = s.slice(colonIdx + 1);
    s = s.slice(0, colonIdx);
  }
  const p = s.trim();
  if (hash !== null && /^L?\d+$/.test(hash)) return { path: p, symbol: null };
  if (colon !== null && /^\d+$/.test(colon)) return { path: p, symbol: null };
  if (hash !== null) return { path: p, symbol: hash.trim() || null };
  return { path: p, symbol: null };
}

/**
 * Ground one code source against the PINNED commit: the path must exist in
 * that commit's tree (`git cat-file -e <sha>:<path>`), and a symbol must
 * appear IN THAT FILE at that commit (`git grep -F -- <symbol> <sha> --
 * <path>` — never repo-wide). An unknown sha degrades to unchecked, not
 * ungrounded; a git-grep "no match" (exit 1) is ungrounded, while any
 * other exec failure leaves the claim unchecked (a check that could not
 * run must not manufacture a finding).
 */
export async function groundCodeSource(
  execFn: ExecFn,
  repoRoot: string,
  source: string,
  pinnedSha: string,
): Promise<"grounded" | "ungrounded" | "unchecked"> {
  const { path: p, symbol } = parseCodeSource(source);
  if (!p) return "unchecked";
  if (pinnedSha === "unknown") return "unchecked";
  const q = JSON.stringify(p);
  try {
    await execFn(`git cat-file -e ${pinnedSha}:${q}`, { cwd: repoRoot });
  } catch {
    return "ungrounded";
  }
  if (!symbol) return "grounded";
  try {
    const { stdout: hits } = await execFn(
      `git grep -F -- ${JSON.stringify(symbol)} ${pinnedSha} -- ${q}`,
      { cwd: repoRoot },
    );
    return hits.trim() ? "grounded" : "ungrounded";
  } catch (e) {
    if (e instanceof Error && /^exit 1$/.test(e.message)) return "ungrounded";
    return "unchecked";
  }
}

/**
 * The deterministic check for one resolved part. Returns the verification
 * to attach (or null for parts another pass covers), plus the URLs any
 * liveness part needs fetched. external-code parts whose ref gives no
 * formable URL stay unchecked with the "external repo" reason.
 */
export async function checkPart(
  part: ResolvedSource,
  execFn: ExecFn,
  repoRoot: string,
  pinnedSha: string,
  statFn: StatLike,
): Promise<{ v: ClaimVerification | null; url?: string }> {
  if (part.kind === "local" && part.localPath) {
    return { v: { check: "local-file", status: await checkLocalFile(part.localPath, statFn) } };
  }
  if (part.kind === "code" && part.path) {
    const status = await groundCodeSource(execFn, repoRoot, part.path, pinnedSha);
    if (status === "unchecked") return { v: { check: "none", status: "unchecked" } };
    return { v: { check: "code-grounding", status } };
  }
  if (part.externalUnchecked)
    return { v: { check: "none", status: "unchecked", reason: "external repo" } };
  if (part.url)
    return {
      v: {
        check: "none",
        status: "unchecked",
        reason: part.kind === "external-code" ? "external repo" : undefined,
      },
      url: part.url,
    };
  return { v: { check: "none", status: "unchecked" } };
}
