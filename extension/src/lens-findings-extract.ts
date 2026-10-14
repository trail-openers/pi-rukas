/**
 * lens-findings-extract — turns a lens child's `report_finding` tool calls into
 * findings. Moved out of lens-review-format.ts for the 500-line gate; that
 * module re-exports `extractFindings` so its importers are unchanged.
 */
import type { Severity } from "./lens-review-format.ts";
import type { Finding } from "./lens-review.ts";

/**
 * Extract findings from the child's tool_use events. Each report_finding
 * invocation becomes one Finding. No text parsing involved — the schema is
 * validated by Pi inside the child process, so malformed calls never reach
 * this code.
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
      line: typeof i.line === "number" ? i.line : 0,
      title,
      description: typeof i.description === "string" ? i.description : undefined,
      suggestion: typeof i.suggestion === "string" ? i.suggestion : undefined,
    });
  }
  return { findings: out, skipped };
}

function normalisePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}
