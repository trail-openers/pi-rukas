/**
 * lens-findings-extract — turns a lens child's `report_finding` tool calls into
 * findings. Moved out of lens-review-format.ts for the 500-line gate (#1125);
 * the re-export shim that module used to keep for old importers is gone, so
 * `extractFindings` is now imported from here — its only definition.
 */
import type { Severity } from "./lens-review-format.ts";
import type { Finding, SeverityCap } from "./lens-review-types.ts";
import { readReproduction } from "./review-findings-reproduction.ts";

/**
 * Extract findings from the child's tool_use events. Each report_finding
 * invocation becomes one Finding. No text parsing involved — the schema is
 * validated by Pi inside the child process, so malformed calls never reach
 * this code.
 *
 * VALIDATION ONLY. This function decides what is a well-formed finding and
 * counts the ones that are not (`skipped`); it applies no policy to a finding
 * it accepted. The severity cap lives on the merge path in lens-review.ts, so
 * the extraction counter stays a count of malformed calls and nothing else can
 * hide behind it.
 */
export function extractFindings(
  toolUses: unknown[],
  lens: string,
): { findings: Finding[]; skipped: number } {
  const out: Finding[] = [];
  let skipped = 0;
  for (const tu of toolUses) {
    if (!tu || typeof tu !== "object") continue;
    const t = tu as { name?: string; arguments?: unknown };
    if (t.name !== "report_finding" || !t.arguments || typeof t.arguments !== "object") continue;
    const i = t.arguments as Record<string, unknown>;
    const severity = String(i.severity ?? "").toUpperCase();
    if (!["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(severity)) {
      skipped++;
      continue;
    }
    const filePath = typeof i.path === "string" ? i.path : "";
    const title = typeof i.title === "string" ? i.title : "";
    if (!filePath || !title) {
      skipped++;
      continue;
    }
    out.push({
      lens,
      severity: severity as Severity,
      path: normalisePath(filePath),
      // #1469 — a call that omits `line` is a FILE-LEVEL finding, and it used to
      // arrive as `line: 0`. The round then dropped the falsy 0, so "no line"
      // was expressible only as a hash coincidence and the fate rule could not
      // tell a file-level finding from anything else that had lost its line.
      // Say it explicitly, and keep 0 out of the public Finding shape so the
      // renderers and dedupe keys never conflate line-less with line-zero.
      ...(typeof i.line === "number" ? { line: i.line } : {}),
      title,
      description: typeof i.description === "string" ? i.description : undefined,
      suggestion: typeof i.suggestion === "string" ? i.suggestion : undefined,
      // #2040 — the reproduction the child claims for a HIGH. Carried only in
      // its well-formed shape: a string, an object missing either field, or one
      // whose fields are not strings is DROPPED rather than counted as a
      // malformed call. The finding itself is a real finding; only its evidence
      // claim is unreadable, and the cap treats a row with no evidence exactly
      // as unproven, so refusing the field cannot under-report.
      ...(readReproduction(i.reproduction)
        ? { reproduction: readReproduction(i.reproduction) }
        : {}),
      // The cap provenance is the row's own history: a row extracted straight
      // from a tool call was never moved by a cap, and the merge-path caps are
      // the only writers of the marker. Read it back only when the call carried
      // one (a row replayed from a stored blob), so an absent field never
      // becomes an own `undefined`.
      ...(readCap(i.severityCapped) ? { severityCapped: readCap(i.severityCapped) } : {}),
    });
  }
  return { findings: out, skipped };
}

/** The cap marker, or nothing: an unknown spelling is no marker at all. */
function readCap(v: unknown): SeverityCap | undefined {
  return v === "test-path" || v === "unproven" ? v : undefined;
}

function normalisePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}
