import type { MechanicalInventory } from "./plan-inventory.ts";
/**
 * plan-duplicate-self — the deterministic post-filter that stops the /plan
 * duplicate-risk check naming the issue it was asked to plan (#1856).
 *
 * Field evidence: two of seven plan sessions on an external factory handed off
 * at exit 10 with a HIGH duplicate verdict, and on one of them the named
 * "duplicate" was the issue being planned itself ("#869 (OPEN …) already covers
 * this exact scope verbatim"). The descriptor of a plan started FROM an
 * existing issue is a near-copy of that issue's own title, and the mechanical
 * inventory plus the prior-context rows both feed the child a verbatim listing
 * of it — so the child's most confident duplicate is the ticket under plan.
 *
 * Three rules, all deterministic, none of them a judgment about the model's
 * reasoning:
 *
 *   1. The source issue N and its own split children are never duplicates. They
 *      are the SUBJECT of the plan. Excluded wherever they appear: the
 *      inventory rows, the prior-context rows, the child's prompt, and the
 *      verdict's named issues.
 *   2. A CLOSED issue that the child ITSELF called prior art or a reversal
 *      target is what the child's own charter says is not a duplicate, so a
 *      HIGH that rests only on those is downgraded, not believed.
 *   3. Anything else stands: a HIGH that names one other OPEN issue halts
 *      exactly as it did before.
 *
 * An ABSENT marker is never a downgrade — `parseDuplicateRisk` defaults an
 * unparsed reply to medium, and recording that as an intentional suppression
 * would let a crashed child read as a decision the driver made.
 *
 * The state comparison is case-insensitive on purpose: `mapGhIssue` upper-cases
 * (`OPEN`/`CLOSED`) while the inventory stores whatever `NormalizedIssue.state`
 * carried, so a case-sensitive rule never matches a GitLab-sourced row.
 */
import type { DuplicateRisk, ExcludedDuplicate } from "./plan-investigate.ts";

/** The prior-context source tag the duplicate-risk child is shown for a related issue. */
const ISSUE_SOURCE_RE = /^issue #(\d+) \(/;

/**
 * Words that make a CLOSED issue the child's own prior art / reversal target —
 * the vocabulary its charter hands it ("prior art or a REVERSAL target").
 * Matched per sentence, never across the whole rationale: a reply that
 * discharges rule 1 for the planned issue and then halts on a genuinely open
 * duplicate must not have that open finding's own wording read back as a
 * prior-art claim about the closed issue.
 */
const PRIOR_ART_RE =
  /\b(prior art|reversal|revers(?:e|es|ed|ing)|supersed\w*|overturn\w*|landed|deliberate(?:ly)?\s+chang\w*)\b/i;

/** The rule that removed a candidate, rendered into the disclosure. */
export const EXCLUSION_REASONS = {
  source: "the issue this plan is for (a plan is not the duplicate of its own subject)",
  "split-child": "the planned issue's own split child",
  "prior-art": "a CLOSED issue the risk check itself called prior art or a reversal target",
} as const;

/** Is this issue state "closed", however the forge spelled it? */
export function isClosedState(state: string): boolean {
  return state.trim().toUpperCase() === "CLOSED";
}

/**
 * One issue a rationale names: the numeric id when the forge has one, and the
 * `N-k` split-child token as `parent`/`child` (a plain `Number()` of "1856-2"
 * is NaN, so the token cannot travel as a number).
 */
export interface NamedIssueRef {
  /** The numeric id, or NaN for a split-child token. */
  id: number;
  /** The token as written in the rationale, without the `#`. */
  token: string;
  /** Set when the token is a split-child id (`N-k`). */
  parent?: number;
  child?: number;
}

/** Every `#N` (or `#N-k`) token a rationale names, in order, deduped by token. */
export function namedIssueRefs(text: string): NamedIssueRef[] {
  const out: NamedIssueRef[] = [];
  for (const m of text.matchAll(/#(\d+(?:-\d+)?)/g)) {
    const token = m[1] ?? "";
    if (out.some((r) => r.token === token)) continue;
    if (token.includes("-")) {
      const [parent, child] = token.split("-").map((x) => Number(x));
      if (
        Number.isSafeInteger(parent) &&
        child !== undefined &&
        Number.isSafeInteger(child) &&
        child >= 1
      ) {
        out.push({ id: Number.NaN, token, parent, child });
      }
      continue;
    }
    const id = Number(token);
    if (Number.isSafeInteger(id) && id > 0) out.push({ id, token });
  }
  return out;
}

/** The numeric ids a rationale names (split-child tokens excluded). */
export function namedIssueTokens(text: string): number[] {
  return namedIssueRefs(text)
    .map((r) => r.id)
    .filter((n) => Number.isSafeInteger(n));
}

/**
 * The rationale split into the clauses the prior-art rule is judged on: a
 * CLOSED issue is prior art only when the sentence naming IT says so. A
 * sentence is the window after the previous `#N` token and up to the next —
 * the sentence's own commas included, so "closes #103, which was prior art"
 * still reaches the rule.
 */
function clauseNaming(text: string, token: string): string {
  const at = text.indexOf(`#${token}`);
  if (at < 0) return "";
  const next = text.slice(at + 1).search(/#\d/);
  return next < 0 ? text.slice(at) : text.slice(at, at + 1 + next);
}

/**
 * Is `n` the source issue itself, or one of its split children? A split child
 * of issue N is anything the child or the inventory writes as `N-k` (the
 * decomposition id form a planner uses for an issue's own sub-issues), so
 * `#869-2` is the subject, never a duplicate. A bare `#N` is decided by
 * `number === source` at the call site, so an unrelated `N` from some other
 * numbering can never be mistaken for the subject.
 */
export function isSplitChildOf(parent: number, source: number): boolean {
  return Number.isSafeInteger(parent) && parent === source;
}

/** The inventory rows for a plan of issue `source`, with the subject removed. */
export function relatedExcludingSource(
  inv: MechanicalInventory,
  source: number | undefined,
): MechanicalInventory["related"] {
  if (source === undefined) return inv.related;
  return inv.related.filter((r) => r.number !== source && !isSplitChildOf(r.number, source));
}

/**
 * The prior-context rows the duplicate-risk child sees, with the subject
 * removed. `assemblePriorContext` pushes `issue #N (STATE)` entries straight
 * from the inventory, so without this the "PM has already established" block
 * names the planned issue itself — the second self-match vector.
 */
export function priorContextExcludingSource(
  priorContext: { source: string; fact: string }[],
  source: number | undefined,
): { source: string; fact: string }[] {
  if (source === undefined) return priorContext;
  return priorContext.filter((p) => {
    const m = ISSUE_SOURCE_RE.exec(p.source);
    if (!m) return true;
    const n = Number(m[1]);
    return n !== source && !isSplitChildOf(n, source);
  });
}

/** What the inventory knows about one issue number. */
export interface KnownIssue {
  state: string;
  title: string;
}

/**
 * The post-filter. `verdict` is what the child's marker parsed to; a failed
 * dispatch (no verdict at all) and an absent marker both come back untouched —
 * nothing here may invent a downgrade. `known` maps an issue number to what the
 * inventory carried for it; a number with no row has no known state, so it can
 * never satisfy the CLOSED-prior-art rule and its HIGH stands.
 */
export function downgradeSelfDuplicate(
  verdict: DuplicateRisk,
  args: { sourceIssue?: number; known?: Map<number, KnownIssue> },
): DuplicateRisk {
  if (verdict.downgradedFrom !== undefined) return verdict;
  if (verdict.level.toLowerCase() !== "high") return verdict;
  const source = args.sourceIssue;
  if (source === undefined) return verdict;
  const named = namedIssueRefs(verdict.rationale);
  // A HIGH that names NO issue cannot be attributed to the subject, so it is
  // not the defect this filter exists for and it halts as any other HIGH does.
  if (named.length === 0) return verdict;
  const known = args.known ?? new Map<number, KnownIssue>();
  const excluded: ExcludedDuplicate[] = [];
  for (const ref of named) {
    // A split-child token: #<parent>-<k> of the planned issue is its own
    // decomposition, never a duplicate of it.
    if (ref.parent !== undefined) {
      if (!isSplitChildOf(ref.parent, source)) return verdict;
      excluded.push({
        number: ref.parent,
        state: known.get(ref.parent)?.state ?? "unknown",
        title: known.get(ref.parent)?.title ?? "",
        reason: EXCLUSION_REASONS["split-child"],
      });
      continue;
    }
    const n = ref.id;
    const row = known.get(n);
    if (n === source) {
      excluded.push(excludedRow(n, row, EXCLUSION_REASONS.source));
      continue;
    }
    if (
      row !== undefined &&
      isClosedState(row.state) &&
      PRIOR_ART_RE.test(clauseNaming(verdict.rationale, ref.token))
    ) {
      excluded.push(excludedRow(n, row, EXCLUSION_REASONS["prior-art"]));
      continue;
    }
    // A named issue the filter may not suppress: the verdict stands and halts.
    return verdict;
  }
  return {
    ...verdict,
    level: "medium",
    downgradedFrom: "high",
    downgradeReason: `every issue the duplicate-risk check named was the plan's own subject or closed prior art (${excluded
      .map((e) => `#${e.number}: ${e.reason}`)
      .join("; ")})`,
    excludedIssues: excluded,
  };
}

function excludedRow(
  number: number,
  row: KnownIssue | undefined,
  reason: string,
): ExcludedDuplicate {
  return { number, state: row?.state ?? "unknown", title: row?.title ?? "", reason };
}

/**
 * The disclosure the drafted/filed body carries: which duplicate candidates the
 * driver suppressed, and on what grounds. Rendered at ONE fixed site
 * (`filedBodyOf`) so the prior-context budget cannot clip it away the way it
 * clips an inventory row.
 */
export function duplicateExclusionSection(
  risk: DuplicateRisk | undefined,
  sourceIssue: number | undefined,
): string {
  if (sourceIssue === undefined || !risk) return "";
  const rows = (risk.excludedIssues ?? [])
    .map((e) => `- #${e.number}${e.state === "unknown" ? "" : ` (${e.state})`}: ${e.reason}`)
    .join("\n");
  if (rows === "") return "";
  const downgraded =
    risk.downgradedFrom === undefined
      ? ""
      : ` The check reported ${risk.downgradedFrom} and was downgraded to ${risk.level}.`;
  return `## Duplicate check — excluded candidates\n\nThis plan is for existing issue #${sourceIssue}, so that issue and its own split children are not duplicate candidates. The candidates below were excluded from the duplicate-risk verdict (${risk.level}).${downgraded}\n${rows}\n`;
}
