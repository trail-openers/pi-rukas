/**
 * memory-write — what the driver persists, deterministically.
 *
 * The driver does not ask an agent to remember to record something; it records
 * what it already holds. The only structured knowledge a `/work` cycle actually
 * produces is its lens findings — measured across 16 real cycles,
 * `lens-issues-found` fired 6 times carrying 21 findings, while
 * `adversarial-rejected` and `verify-full-status` fired zero times. So that is
 * the write source, and there is exactly one.
 *
 * ## Why rows are short
 *
 * Not because short rows retrieve better — measured on the live store, they do
 * not. The four most-retrieved rows are 731, 241, 626 and **1598** chars; a
 * 1598-char guard has been retrieved 25 times. Length and retrieval are
 * unrelated.
 *
 * They are short because of **injection cost**. A brief carries up to 10 hits
 * into a subagent prompt, and the corpus median is 741 chars — so an unbounded
 * brief is ~7 KB of prompt before the diff. One claim per row keeps each hit
 * cheap and makes the claim checkable in isolation, which is what
 * `renderBrief`'s "verify before acting" framing actually asks of the reader.
 *
 * ## Why every row is a candidate
 *
 * A candidate is invisible to a default read, so a wrong row influences nothing
 * until something promotes it. That is the whole safety argument for writing
 * automatically at all: the blast radius of a bad write is zero until a human
 * or a later rule acts on it.
 */

import path from "node:path";
import { type MemoryType, type VipuneOpts, type VipuneResult, vipuneAdd } from "./vipune.ts";

/**
 * Hard cap per cycle.
 *
 * Measured: `lens-issues-found` carried 21 findings across 6 firings, so a
 * typical cycle offers 3-5. Three is enough to capture the substance of a
 * review without turning the store into a log — and the corpus research is
 * consistent that a small curated store outperforms a large accumulated one.
 */
export const MAX_WRITES_PER_CYCLE = 3;

/** Content ceiling. Well under the seam's 1000-char refusal, on purpose. */
export const MAX_MEMORY_CHARS = 300;

/** Metadata every driver write carries. Validated before the binary is reached. */
export interface MemoryMetadata extends Record<string, unknown> {
  src: "pi-ensemble";
  issue: number;
  file: string;
  kind: "lens-finding";
  cycle?: string;
}

/**
 * Validate metadata before spawning.
 *
 * vipune does NOT validate `-m`: measured, `-m '{not json'` is accepted at exit
 * 0 and stored verbatim, which then breaks every reader that parses it. A write
 * path that can corrupt its own read path is worse than one that refuses.
 */
export function validMetadata(m: unknown): m is MemoryMetadata {
  if (!m || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  if (r.src !== "pi-ensemble" || r.kind !== "lens-finding") return false;
  if (typeof r.issue !== "number" || !Number.isFinite(r.issue)) return false;
  if (typeof r.file !== "string" || r.file.length === 0) return false;
  if (r.cycle !== undefined && typeof r.cycle !== "string") return false;
  // Round-trip: whatever we are about to hand the CLI must survive a parse, or
  // the read side inherits a row it cannot interpret.
  try {
    JSON.parse(JSON.stringify(m));
  } catch {
    return false;
  }
  return true;
}

/** A lens finding, in the shape `lens-review` already produces. */
export interface FindingLike {
  path: string;
  title: string;
  severity: string;
}

/**
 * Shape one finding into a memory.
 *
 * Leads with the basename because that is what a later query will be built
 * from — the develop step knows its changed files, not their full paths, and a
 * query and its target should share a literal token so BM25 can fire.
 */
export function memoryContentFor(f: FindingLike): string {
  const base = path.basename(f.path);
  const line = `${base}: ${f.title.trim()}`;
  return line.length > MAX_MEMORY_CHARS ? `${line.slice(0, MAX_MEMORY_CHARS - 1)}…` : line;
}

export interface WriteOutcome {
  outcome: "written" | "cap" | "refused" | "conflict" | "error";
  id?: string;
  detail?: string;
}

/**
 * Persist review findings as capped candidates.
 *
 * Never `--force`. On a conflict the existing row already says this, and a
 * duplicate helps nobody — note the measured asymmetry, though: vipune's
 * conflict detection compares only against ACTIVE rows, so the candidate tier
 * has no dedup of its own and the per-cycle cap is what bounds it.
 */
export async function writeFindings(
  findings: readonly FindingLike[],
  meta: { src: "pi-ensemble"; issue: number; kind: "lens-finding"; cycle?: string },
  opts: VipuneOpts & { memoryType?: MemoryType },
): Promise<WriteOutcome[]> {
  const out: WriteOutcome[] = [];
  for (const f of findings) {
    if (out.filter((o) => o.outcome === "written").length >= MAX_WRITES_PER_CYCLE) {
      out.push({ outcome: "cap", detail: `cap of ${MAX_WRITES_PER_CYCLE} reached` });
      continue;
    }
    const metadata: MemoryMetadata = { ...meta, file: path.basename(f.path) };
    if (!validMetadata(metadata)) {
      out.push({ outcome: "refused", detail: "metadata failed validation" });
      continue;
    }
    let r: VipuneResult;
    try {
      r = await vipuneAdd(memoryContentFor(f), {
        ...opts,
        memoryType: opts.memoryType ?? "guard",
        status: "candidate",
        metadata,
      });
    } catch (err) {
      out.push({ outcome: "error", detail: (err as Error).message?.slice(0, 120) });
      continue;
    }
    out.push(translate(r));
  }
  return out;
}

function translate(r: VipuneResult): WriteOutcome {
  switch (r.kind) {
    case "added":
    case "superseded":
      return { outcome: "written", id: r.id };
    case "conflict":
      return { outcome: "conflict", detail: `${r.conflicts.length} similar row(s) already stored` };
    case "refused":
      return { outcome: "refused", detail: r.reason };
    case "timeout":
      return { outcome: "error", detail: `timed out after ${r.ms}ms` };
    case "absent":
      return { outcome: "error", detail: "vipune not installed" };
    default:
      return { outcome: "error", detail: r.detail };
  }
}
