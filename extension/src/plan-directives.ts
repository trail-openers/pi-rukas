/**
 * plan-directives — the operator's TRUSTED typed channel into a /plan spec.
 *
 * The `context` param is the one input the driver treats as authority (D7):
 * typed blocks parsed here take precedence over specialist output for their
 * fields. This is the deliberate counterpart to DESCRIPTOR_DATA_FRAMING —
 * children are told quoted text is never instructions, so instructions must
 * arrive through this structural channel instead.
 *
 * Grammar (vipune round-9 fixture, 2026-09-10): a heading line opens a
 * block; the block ends at the NEXT heading, an END fence, or a blank line
 * followed by a non-bullet line. Contiguous unbulleted lines are items;
 * bare BEGIN/END fence lines are delimiters, never items. The old parser
 * had no terminator at all — the tester's `TEST SURFACE:\nBEGIN\nnone\nEND`
 * block leaked both fences as bullets and swallowed every trailing prose
 * paragraph into the section. Lines a terminator demotes are NOT lost: the
 * whole context param independently flows into the prior-context inventory.
 *
 * Split out of plan-draft.ts along the 500-line seam (AGENTS.md §12);
 * plan-draft re-exports for existing consumers.
 */

export interface OperatorDirectives {
  acceptanceCriteria: string[];
  pitfalls: string[];
  outOfScope: string[];
  /**
   * TEST SURFACE block — the operator's test-surface items replace the
   * angle-derived ones (vipune fixture run C2: "the Test surface section
   * must contain exactly 'none — no code shipped'" had no structural
   * channel and was ignored). Optional so existing literals stay valid.
   */
  testSurface?: string[];
  /**
   * DECOMPOSITION (or SUB-ISSUES) block — constraints on an epic's
   * decomposition, threaded into the decomposition-surface angle prompt
   * and readable by the pinned-count validator (C5).
   */
  decomposition?: string[];
}

const KEYWORD =
  "(ACCEPTANCE[\\s-]*CRITERIA|PITFALLS|EDGE[\\s-]*CASES|OUT[\\s-]*OF[\\s-]*SCOPE|TEST[\\s-]*SURFACE|DECOMPOSITION|SUB[\\s-]*ISSUES?)";

/**
 * A keyword line is a heading ONLY when the keyword (with optional
 * `#`/`=`/`*`/backtick wrappers and an optional parenthetical, D4) is
 * followed by a colon (+ optional residual first item), a BEGIN/END fence
 * token, closing wrapper chars, or end-of-line. A keyword flowing into
 * ordinary prose ("Out of scope for this round was…") no longer hijacks
 * the open block (round-9 bonus defect).
 */
const HEADING_RE = new RegExp(
  `^(?:[#=*\`]+\\s*)?${KEYWORD}(?:\\s*\\([^)]*\\))?\\s*(?:(?:[#=*\`]+)?\\s*[:：]\\s*(.*)$|(BEGIN|END)\\s*(?:[#=*\`]+\\s*)?$|[#=*\`]*\\s*$)`,
  "i",
);

/** A bare fence line inside an open block: END terminates, BEGIN is skipped. */
const FENCE_RE = /^[-=\s]*(BEGIN|END)[-=\s]*$/i;

/** Bullet-list continuation marker (also keeps spaced lists open across blanks). */
const BULLET_RE = /^(?:[-*]+|\d+[.)])\s+/;

function channelFor(name: string): keyof OperatorDirectives {
  const up = name.toUpperCase();
  return up.startsWith("ACCEPTANCE")
    ? "acceptanceCriteria"
    : up.startsWith("OUT")
      ? "outOfScope"
      : up.startsWith("TEST")
        ? "testSurface"
        : up.startsWith("DECOMPOSITION") || up.startsWith("SUB")
          ? "decomposition"
          : "pitfalls";
}

/**
 * Iterated bullet strip. Whitespace after the marker is REQUIRED, so
 * digit-leading prose ("42 is the answer", "3.14 pi") and PEM-style
 * "-----BEGIN X-----" lines survive intact; "- 1) x" still double-strips
 * to "x" (the old single-pass class regex ate any run of `-*digits.)`).
 */
function stripBullet(line: string): string {
  let out = line;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(BULLET_RE, "");
  }
  return out.trim();
}

/**
 * Parse operator-supplied typed fields out of the `context` param (D7).
 * Headings: ACCEPTANCE CRITERIA, PITFALLS (or EDGE CASES), OUT OF SCOPE,
 * TEST SURFACE, DECOMPOSITION (or SUB-ISSUES). Grammar in the module header.
 */
export function parseOperatorDirectives(context: string | undefined): OperatorDirectives {
  const out: Required<OperatorDirectives> = {
    acceptanceCriteria: [],
    pitfalls: [],
    outOfScope: [],
    testSurface: [],
    decomposition: [],
  };
  if (!context || !context.trim()) return out;
  const lines = context.split("\n");
  let target: keyof OperatorDirectives | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) {
      // Blank line: the block ends unless the list continues with a bullet
      // (one-token lookahead); a following heading re-opens its own block.
      if (target !== null) {
        let j = i + 1;
        while (j < lines.length && !(lines[j] ?? "").trim()) j++;
        const next = j < lines.length ? (lines[j] ?? "").trim() : "";
        if (!BULLET_RE.test(next)) target = null;
      }
      continue;
    }
    const m = line.match(HEADING_RE);
    if (m) {
      target = channelFor(m[1] ?? "");
      if ((m[3] ?? "").toUpperCase() === "END") {
        target = null; // "TEST SURFACE END" closes the block
        continue;
      }
      const rest = (m[2] ?? "").trim();
      // Colon residual becomes the first item ("PITFALLS: the retry path")
      // — unless it is wrapper chars ("**ACCEPTANCE CRITERIA:**") or a
      // fence token ("TEST SURFACE: BEGIN").
      if (/^END$/i.test(rest)) target = null;
      else if (rest && !/^[#=*`]+$/.test(rest) && !/^BEGIN$/i.test(rest)) out[target].push(rest);
      continue;
    }
    if (!target) continue;
    if (FENCE_RE.test(line)) {
      if (/END/i.test(line)) target = null;
      continue;
    }
    const bullet = stripBullet(line);
    if (bullet) out[target].push(bullet);
  }
  return out;
}
