/**
 * The offload-helper functions the #682 offloaded-spec fixture asserts on,
 * moved out of test-work-driver-offloaded-spec.ts so that file fits AGENTS.md
 * §12's 500-line cap. They stayed inline originally so the test would be
 * self-contained and pass the seam-wired gate (an unused production module is
 * exactly what that gate catches); moving them into a lib the test imports
 * keeps that property — nothing here is production code, and the only caller
 * is the smoke test.
 *
 * These are the fixture's OWN re-implementations, deliberately NOT imported
 * from production: the test pins the CONTRACT the offload wiring must satisfy,
 * and asserting against a copy is what lets it fail before the wiring lands.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { NormalisedSpec } from "../../src/work-driver-intent.ts";
import { parseNormalisedSpec } from "../../src/work-driver-intent.ts";
import { readMarker } from "../../src/reply-markers.ts";
import { scratchDir } from "../../src/work-driver-workspace.ts";

const VERDICT_VALUES = /(proceed-with-assumptions|proceed|park)/;

export function hasParseableIntentVerdict(reply: string): boolean {
  return readMarker(reply, "INTENT-VERDICT", VERDICT_VALUES) !== undefined;
}

export function hasInlineSpecHeading(reply: string): boolean {
  let fenced = false;
  for (const line of reply.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^\s*##\s+Spec\b/.test(line)) return true;
  }
  return false;
}

export function citedFilePaths(reply: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?<![\w/.\-])(?:[A-Za-z]:[\\\/]|[\w.\-]+(?:\/[\w.\-]+)+\/[\w.\-]+)/g;
  for (const m of reply.matchAll(re)) {
    const p = m[0];
    if (!/[.]\w{1,10}$/.test(p)) continue;
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export function resolvesUnderScratch(
  cited: string,
  repoRoot: string,
  issue: number,
): boolean {
  const dir = scratchDir(repoRoot, issue);
  const resolved = path.resolve(repoRoot, cited);
  const relative = path.relative(dir, resolved);
  if (relative === "") return true;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function recoverOffloadedSpec(
  reply: string,
  repoRoot: string,
  issue: number,
): Promise<NormalisedSpec | undefined> {
  for (const cited of citedFilePaths(reply)) {
    if (!resolvesUnderScratch(cited, repoRoot, issue)) continue;
    const resolved = path.resolve(repoRoot, cited);
    let file: string;
    try {
      const st = await stat(resolved);
      if (!st.isFile()) continue;
      file = await readFile(resolved, "utf8");
      if (file.trim() === "") continue;
    } catch {
      continue;
    }
    const spec = parseNormalisedSpec(file);
    if (spec !== undefined) return spec;
  }
  return undefined;
}
