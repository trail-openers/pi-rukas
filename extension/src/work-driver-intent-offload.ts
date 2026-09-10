/**
 * work-driver-intent-offload — offload-spec recovery for the explore step.
 *
 * The prompt's own scratch-hygiene section tells the resolver "write any
 * ephemeral artefacts under: `<scratchDir>`", and a resolver that writes the
 * full spec there keeps only a summary + fenced verdict inline. That reply
 * shape is legitimate, and the driver's `parseNormalisedSpec` — which gates
 * the whole parse on an inline `## Spec` heading — used to return undefined
 * before the present, valid INTENT-VERDICT token was even consulted, so the
 * cycle parked with a false `explore-needs-clarification` cap-hit (#682).
 *
 * When the inline text has a PARSEABLE INTENT-VERDICT but no `## Spec`
 * heading, and the reply cites a file path, `recoverOffloadedSpec` reads the
 * first cited candidate whose resolved location sits under the cycle's own
 * scratch dir and parses its content with the SAME `parseNormalisedSpec`
 * call — same `sliceMarkdownSection` contract, no second parser. The
 * containment check is the security boundary: the resolver (an LLM) controls
 * the cited path, so a path that resolves outside the scratch dir (`../`, an
 * absolute path, a sibling cycle's `tmp/issue-<other>/`) is never read.
 *
 * Every miss case — no parseable verdict, no citation, unreadable/missing
 * file, no `## Spec` block in the file — returns `undefined` and the caller
 * falls through to today's behaviour unchanged (legacy verdict router →
 * `exploreProducedNoSignal` → cap-hit on the single-issue intent path).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { readMarker } from "./reply-markers.ts";
import type { NormalisedSpec } from "./work-driver-intent.ts";
import { parseNormalisedSpec } from "./work-driver-intent.ts";

/**
 * Recover a spec from a scratch-offloaded file when the inline reply has a
 * parseable INTENT-VERDICT but no `## Spec` heading.
 *
 * Gate 1: if the inline text already parses a spec, return it as-is and
 * never touch the offload path.
 *
 * Gate 2: the fallback is for a resolver that DECIDED (stated a parseable
 * INTENT-VERDICT). A reply with neither a spec block nor a parseable verdict
 * is the no-signal case — untouched. The gate is on token PRESENCE, not
 * value: the recovered spec's verdict is set from the OFFLOADED file's own
 * token (parsed by `parseNormalisedSpec` below), and `reconcileVerdict`
 * downstream applies the same contradiction/assumption/promotion logic it
 * would for an inline spec.
 *
 * The shared reader's inline pattern tolerates bold AROUND the token but
 * not bold immediately before it with the value also inside the bold
 * markers — the exact shape the live 674 reply uses
 * (`**INTENT-VERDICT: proceed-with-assumptions**`). The presence gate
 * therefore checks both shapes.
 */
export async function recoverOffloadedSpec(
  reply: string,
  scratchDirAbs: string,
): Promise<NormalisedSpec | undefined> {
  const parsed = parseNormalisedSpec(reply);
  if (parsed !== undefined) return parsed;

  const hasVerdictToken =
    readMarker(reply, "INTENT-VERDICT", /[a-z-]+/) !== undefined ||
    /\*{0,2}\s*INTENT-VERDICT\s*:?\s*\*{0,2}\s*:?\s*[a-z-]+/i.test(reply);
  if (!hasVerdictToken) return undefined;

  const candidates = extractCitedPaths(reply);
  if (candidates.length === 0) return undefined;

  const root = path.resolve(scratchDirAbs);
  for (const candidate of candidates) {
    const resolved = resolveCitedUnderScratch(root, candidate);
    if (resolved === undefined) continue;
    let content: string;
    try {
      content = await fs.readFile(resolved, "utf8");
    } catch {
      continue;
    }
    const offloaded = parseNormalisedSpec(content);
    if (offloaded !== undefined) return offloaded;
  }
  return undefined;
}

/**
 * Resolve a cited path to a location under the scratch dir, or `undefined`
 * when it cannot be safely mapped there.
 *
 * Three shapes, in order:
 *
 *   1. Absolute path — accepted only if it already resolves under `root`.
 *      A resolver that cites `/abs/path/report.md` means exactly that
 *      location; the driver must not silently remap it.
 *   2. Repo-relative path with a `tmp/issue-<N>/` prefix — the resolver's
 *      convention is to cite the scratch path as it appears in the repo
 *      (the live 674 reply cited `tmp/issue-674/explore-report.md` while
 *      the scratch dir was `<repoRoot>/tmp/issue-674`). The prefix is
 *      stripped and the remainder is resolved against `root`.
 *   3. A bare path — resolved against `root` directly.
 *
 * Every case is checked with `isUnderScratchDir`, so a path that resolves
 * outside the scratch dir (a sibling cycle's `tmp/issue-<other>/`, a `../`
 * escape, an absolute path elsewhere) is a hard reject.
 */
function resolveCitedUnderScratch(root: string, candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (path.isAbsolute(trimmed)) {
    const resolved = path.resolve(trimmed);
    return isUnderScratchDir(resolved, root) ? resolved : undefined;
  }
  const segments = trimmed.split("/").filter(Boolean);
  const rootName = path.basename(root);
  let idx = 0;
  if (segments[0] === "tmp" && segments[1] === rootName) {
    idx = 2;
  } else if (segments[0] === ".pi") {
    idx = 1;
  }
  if (segments[0] === "." && idx === 0) idx = 1;
  const remainder = segments.slice(idx).join("/");
  if (!remainder) return undefined;
  const resolved = path.resolve(root, remainder);
  return isUnderScratchDir(resolved, root) ? resolved : undefined;
}

/**
 * Is `resolved` at or under `root`? Uses `path.relative` rather than a
 * string-prefix test, so `/repo/tmp/issue-674-other` is not accepted for
 * `/repo/tmp/issue-674`.
 */
function isUnderScratchDir(resolved: string, root: string): boolean {
  const rel = path.relative(root, resolved);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Extract file-path citations from a resolver's reply, in order of
 * appearance.
 *
 * Accepted shapes: backticked paths, `./`-relative paths, bare relative
 * paths (`tmp/issue-674/report.md`), and absolute paths. Only paths that
 * carry a file extension are treated as citations — prose that mentions a
 * directory ("saved under tmp/issue-674") is not a spec citation.
 *
 * The scan is deliberately tolerant of markdown fences/bold: the live 674
 * reply carries its citations in plain prose and its verdict in a fenced
 * block, and a resolver may cite a path inside either.
 */
export function extractCitedPaths(reply: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /`?((?:\.\/|\.\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})`?/g;
  for (const m of reply.matchAll(re)) {
    const p = m[1] ?? "";
    if (/^\w+$/.test(p)) continue;
    if (/[?#:]/.test(p)) continue;
    const key = path.posix.normalize(p.replace(/^\.\//, ""));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
