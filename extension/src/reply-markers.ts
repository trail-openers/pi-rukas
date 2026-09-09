/**
 * reply-markers — reading a `TOKEN: value` marker out of a subagent's reply.
 *
 * Every step in this driver asks a child to end with a structured marker, and
 * every step grew its own matcher for it. They drifted, and each drifted into
 * the same defect: **a marker that fails to parse produces a confident wrong
 * answer rather than an obvious failure.**
 *
 *   - `parseVerdict` (adversarial) was case-sensitive with no bold tolerance,
 *     so `**VERDICT: APPROVED**` fell through to `ISSUES_FOUND` — and handed
 *     the fix-developer the entire approval message as its list of findings.
 *   - the `ci` step used a bare `text.includes("ci-status: success")`, so any
 *     emphasis or capitalisation drift silently became a CI failure, burning
 *     the retry budget and parking a green cycle.
 *   - `PARK-REASON` was colon-anchored, so a resolver writing it as a heading
 *     got the synthesised default `underspecified` instead — which #397's
 *     override then read as a diagnosis and used to license building the
 *     wrong thing (#404).
 *
 * One reader, shared, tolerant of the shapes agents actually emit — and, just
 * as importantly, able to say **"absent"** distinctly from **"parsed as X"**.
 * The callers are what decide whether absence is safe; they cannot decide it
 * if the parser has already collapsed the two.
 */

/**
 * Read a `TOKEN: value` marker, in every shape real replies use.
 *
 * Accepted (`token` = `VERDICT`, values `APPROVED|ISSUES_FOUND`):
 *
 *     VERDICT: APPROVED
 *     **VERDICT:** APPROVED
 *     **VERDICT: APPROVED**
 *     verdict: approved
 *     ### VERDICT
 *     APPROVED
 *
 * `value` must contain exactly one capture group. Returns the matched value
 * lowercased, or `undefined` when the marker is genuinely absent — which is
 * information, not a failure to paper over.
 */
export function readMarker(text: string, token: string, value: RegExp): string | undefined {
  const v = value.source;
  // LAST match, not first. `text.match` without /g returns the first hit, and a
  // reviewer that mentions the token while thinking — "I will return VERDICT:
  // ISSUES_FOUND if the parser is wrong" — had its musing read as its verdict.
  // The marker a model means is the one it ends on.
  const inline = [...text.matchAll(new RegExp(`${token}\\s*:?\\s*\\**\\s*:?\\s*${v}\\b`, "gi"))];
  const lastInline = inline[inline.length - 1];
  if (lastInline?.[1]) return lastInline[1].toLowerCase();
  // Heading form: the token on its own line, the value on the next.
  const headings = [
    ...text.matchAll(
      new RegExp(`^#{1,6}\\s*\\**\\s*${token}\\s*\\**\\s*$\\n+\\s*\\**\\s*${v}\\b`, "gim"),
    ),
  ];
  return headings[headings.length - 1]?.[1]?.toLowerCase();
}

/**
 * Read a marker whose permitted values are a fixed set, returning the value in
 * its canonical (upper-case) form.
 *
 * Convenience over `readMarker` for the many call sites whose value space is
 * an enum; keeps the regex construction in one place so a new call site cannot
 * reintroduce a case-sensitive or emphasis-blind variant.
 */
export function readEnumMarker<T extends string>(
  text: string,
  token: string,
  allowed: readonly T[],
): T | undefined {
  if (allowed.length === 0) return undefined;
  const alt = allowed.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const hit = readMarker(text, token, new RegExp(`(${alt})`, "i"));
  if (!hit) return undefined;
  return allowed.find((a) => a.toLowerCase() === hit);
}

/**
 * MARKER_CONTRACTS — the declared registry of every PROSE marker the
 * drivers route on (seam audit 2026-09-09; the research's "declared
 * contract" P1, sized to this repo: a self-documenting table the canary
 * test walks, not JSON-schema machinery — the tool-call seams
 * (report_policy, report_finding, report_plan_item, report_research_claim)
 * are already TypeBox-validated in-process and are deliberately absent).
 *
 * Each row names the token, its canonical values (or a shape description
 * for open values), the module that routes on it, and what that consumer
 * does on ABSENCE — the axis every marker bug in this repo's history has
 * lived on. test-marker-contracts.ts enforces: every row's consumer exists
 * and contains the token, every enum value appears in the consumer's
 * source, and the known marker-consuming modules all appear here — a new
 * hand-rolled parser fails the gate.
 */
export interface MarkerContract {
  token: string;
  values: readonly string[] | string;
  consumer: string;
  onAbsence: string;
}

export const MARKER_CONTRACTS: readonly MarkerContract[] = [
  {
    token: "VERDICT",
    values: ["CRITICAL_ISSUES_FOUND", "ISSUES_FOUND", "MINOR_OBSERVATIONS", "APPROVED"],
    consumer: "adversarial-verdict.ts",
    onAbsence:
      "verdictParsed=false → fix round mid-loop, `incomplete` at the terminal round (never pass, never reject)",
  },
  {
    token: "ci-status",
    values: ["success", "failure", "pending"],
    consumer: "work-driver-stepback-ci.ts",
    onAbsence:
      "treated as failure (#553 — burns the ci-retry cap rather than idling); executed gh evidence can demote a success, never promote",
  },
  {
    token: "INTENT-VERDICT",
    values: ["proceed", "proceed-with-assumptions", "park"],
    consumer: "work-driver-intent.ts",
    onAbsence: "park with verdictSource=default (#378 — silence is not permission to build)",
  },
  {
    token: "PARK-REASON",
    values: [
      "underspecified",
      "contradicted-by-code",
      "already-implemented",
      "too-large",
      "premise-unsound",
    ],
    consumer: "work-driver-intent.ts",
    onAbsence:
      "underspecified with parkReasonSource=default (#404 — an invented reason must never license building)",
  },
  {
    token: "DUPLICATE_RISK",
    values: ["high", "medium", "low", "none"],
    consumer: "plan-investigate.ts",
    onAbsence:
      "medium (proceed; only high stops) — LAST real marker wins and the echoed `high|medium|low|none` menu is ignored",
  },
  {
    token: "GAP",
    values: "CRITICAL|HIGH|MEDIUM|LOW — <description> — proposed resolution: <r>",
    consumer: "plan-gaps.ts",
    onAbsence:
      "zero gaps, honestly; zero gaps with no VERDICT line is review-unparseable → one strict retry, then fail closed (never files)",
  },
  {
    token: "CLAIM-SUPPORT",
    values: ["full", "partial", "none", "unreachable"],
    consumer: "research-verify.ts",
    onAbsence: "claim stays unannotated (absence is not a verdict; annotation never upgrades)",
  },
  {
    token: "pr",
    values: "<PR number> (`pr: <N>` line)",
    consumer: "work-driver-lens.ts",
    onAbsence: "undefined — downstream gates that need the PR fail their own checks",
  },
];
