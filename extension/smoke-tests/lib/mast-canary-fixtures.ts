/**
 * mast-canary-fixtures — the MAST facts §7 asserts, the mutants that corrupt
 * them, and the checker that judges a copy of the §7 block. Split out of
 * `test-mast-authoritative-block.ts` to keep both files under the size ratchet.
 *
 * **Every figure is joined to the label it belongs to.** A token like
 * `"disobeying the task specification FM-1.1 is 11.8%"` cannot be satisfied by
 * the right number beside the wrong mode, nor by the right number with a digit
 * glued on the front. Ten independent `includes` over bare ids and bare numbers
 * are ten true statements about a paragraph that says something false — swapping
 * the FM-1.1 and FM-1.2 attributions left all ten green — and `includes("15.7%")`
 * is satisfied by `115.7%`, `includes("2.8")` by `42.80`. A mis-paired figure is
 * the same error class as an unscoped superlative, and the superlative already
 * had a positional check while the pairing had none.
 */

/** The paper's id — what site discovery keys on, and what every site names. */
export const ARXIV = "arXiv 2503.13657";

/** The §7 heading token — the locator, so a reflow of the file cannot move it. */
export const PARA_HEAD = "**Theme-clustered cap-hits get a step-back**";

/** The one canonical grammar of the FM-1.3 superlative, as every site prints it. */
export const SUPERLATIVE = "the largest single FM-1.x mode is step repetition FM-1.3 at 15.7%";

/** The same superlative stripped of its scope — the founding fabrication. */
export const UNSCOPED = SUPERLATIVE.replace(" FM-1.x mode", " mode");

/** Corruptions of the canonical superlative, synthesised from it, never read from a file. */
export const NEAR_VARIANTS: readonly string[] = [
  UNSCOPED, // scope word dropped
  SUPERLATIVE.replace(" at 15.7%", ""), // figure dropped, superlative kept
  SUPERLATIVE.replace("step repetition FM-1.3 at 15.7%", "FM-1.3 step repetition at 15.7%"), // clause order permuted
];

/** The three top-level categories, in the paper's own order. */
export const CATEGORY_ORDER = [
  "System Design Issues",
  "Inter-Agent Misalignment",
  "Task Verification",
] as const;

/** One thing the §7 block must state. Named so a failure says which FACT is lost. */
export interface MastFact {
  readonly label: string;
  /** The exact substring that makes it true — a figure joined to its label. */
  readonly token: string;
  readonly why: string;
}

/** The figure, joined to its mode id — and a corruption the bare form used to hide. */
interface Figure {
  readonly label: string;
  readonly mode: string;
  readonly figure: string;
  /** The word joining mode to figure in §7 ("is", "at"), empty for a bare category list. */
  readonly verb: string;
  readonly corrupt: string;
  readonly why: string;
}

/**
 * The paper's figures, settled by three independent extractions. Each row is the
 * single source of both the joined token and its corruption, so a mutant cannot
 * drift away from the fact it claims to break.
 */
const FIGURES: readonly Figure[] = [
  {
    label: "category-system-design",
    mode: "System Design Issues",
    figure: "41.8%",
    verb: "",
    corrupt: "141.8%",
    why: "category figure joined to its name",
  },
  {
    label: "category-inter-agent",
    mode: "Inter-Agent Misalignment",
    figure: "36.9%",
    verb: "",
    corrupt: "136.9%",
    why: "category figure joined to its name",
  },
  {
    label: "category-task-verification",
    mode: "Task Verification",
    figure: "21.3%",
    verb: "",
    corrupt: "121.3%",
    why: "category figure joined to its name",
  },
  {
    label: "fm-1-1-task-specification",
    mode: "disobeying the task specification FM-1.1",
    figure: "11.8%",
    verb: "is",
    corrupt: "111.8%",
    why: "FM-1.1's figure joined to the mode it measures",
  },
  {
    label: "fm-1-2-agent-role",
    mode: "disobeying the agent role FM-1.2",
    figure: "1.5%",
    verb: "is",
    corrupt: "11.5%",
    why: "FM-1.2's figure joined to the mode it measures",
  },
  {
    label: "fm-1-3-step-repetition",
    mode: "step repetition FM-1.3",
    figure: "15.7%",
    verb: "at",
    corrupt: "115.7%",
    why: "FM-1.3's figure joined to the mode it measures",
  },
  {
    label: "fm-1-4-context-loss",
    mode: "context loss FM-1.4",
    figure: "2.80%",
    verb: "is",
    corrupt: "12.80%",
    why: "FM-1.4's figure joined to its mode — pinned to 2.80 so 42.80 cannot satisfy it",
  },
  {
    label: "fm-1-5-completion",
    mode: "not recognising completion FM-1.5",
    figure: "12.4%",
    verb: "is",
    corrupt: "112.4%",
    why: "FM-1.5's figure joined to the mode it measures",
  },
];

const join = (f: Figure): string =>
  f.verb === "" ? `${f.mode} ${f.figure}` : `${f.mode} ${f.verb} ${f.figure}`;
const corruptJoin = (f: Figure): string =>
  f.verb === "" ? `${f.mode} ${f.corrupt}` : `${f.mode} ${f.verb} ${f.corrupt}`;

/** Every numeric fact §7 must carry, each joined to the label it belongs to. */
export const FACTS: readonly MastFact[] = [
  {
    label: "arxiv-id",
    token: `in the MAST taxonomy (Cemri et al., ${ARXIV})`,
    why: "the paper is named by id, so a reader can reach the primary source",
  },
  {
    label: "categories-introduced",
    token: `the top-level categories are ${FIGURES[0].mode} ${FIGURES[0].figure}`,
    why: "the word that scopes the three CATEGORY figures, joined to the first of them",
  },
  ...FIGURES.map((f) => ({ label: f.label, token: join(f), why: f.why })),
  {
    label: "intervention-shape",
    token: "a high-level objective-verification step",
    why: "what the best orchestration-layer intervention actually was",
  },
  {
    label: "intervention-figure",
    token: "was worth +15.6% task success",
    why: "the intervention figure joined to what it improved",
  },
  {
    label: "appendix-h",
    token: "Appendix H states that tactical approaches get only limited results",
    why: "where the paper's own limitation is stated",
  },
];

/** One regression applied to a copy of the real §7 block; the checker must reject it. */
export interface Defect {
  readonly name: string;
  readonly mutate: (para: string) => string;
  readonly expectMissing: string;
}

const drop = (token: string) => (p: string) => p.replace(token, "");

/**
 * Every §7 regression this branch lived through, plus the mutant classes its
 * first version passed green: a prepended digit per figure, and a swap of the
 * FM-1.1 / FM-1.2 attributions.
 */
export const DEFECTS: readonly Defect[] = [
  {
    name: "drops a top-level category figure",
    mutate: drop("Inter-Agent Misalignment 36.9%"),
    expectMissing: "category-inter-agent",
  },
  { name: "drops an FM-1 figure", mutate: drop("12.4%"), expectMissing: "fm-1-5-completion" },
  {
    name: "drops the completion-recognition mode entirely",
    mutate: drop("not recognising completion FM-1.5 is 12.4%, "),
    expectMissing: "fm-1-5-completion",
  },
  {
    name: "drops the context-loss mode entirely",
    mutate: drop("context loss FM-1.4 is 2.80% and "),
    expectMissing: "fm-1-4-context-loss",
  },
  {
    name: "drops the intervention figure",
    mutate: drop("+15.6%"),
    expectMissing: "intervention-figure",
  },
  {
    name: "drops the Appendix H limitation",
    mutate: (p) => p.replace(/Appendix H states[^)]*/, "and it helps"),
    expectMissing: "appendix-h",
  },
  {
    name: "unscopes the superlative (the fabrication this branch removed)",
    mutate: (p) => p.replace(SUPERLATIVE, UNSCOPED),
    expectMissing: "superlative unscoped",
  },
  {
    name: "promotes an FM-1.x mode to top-level",
    mutate: (p) =>
      p.replace(
        "the largest single FM-1.x mode is step repetition FM-1.3",
        "a top-level failure mode, step repetition FM-1.3",
      ),
    expectMissing: "top-level count",
  },
  {
    name: "invents a figure the paper does not carry",
    mutate: (p) => p.replace("context loss FM-1.4 is 2.80%", "context loss FM-1.4 is 41.77%"),
    expectMissing: "fm-1-4-context-loss",
  },
  {
    name: "deletes the whole block",
    mutate: () => `${PARA_HEAD}: PM dispatches one \`@explore\`.`,
    expectMissing: "arxiv-id",
  },
  // One mutant per figure: a digit prepended, which the old bare-token check
  // swallowed ("15.7%" still occurs inside "115.7%", "2.8" inside "42.80").
  ...FIGURES.map(
    (f): Defect => ({
      name: `corrupts "${join(f)}" to "${corruptJoin(f)}" (a prepended digit used to satisfy the bare substring check)`,
      mutate: (p) => p.replace(join(f), corruptJoin(f)),
      expectMissing: f.label,
    }),
  ),
  {
    name: "swaps the FM-1.1 and FM-1.2 attributions (every token present, meaning false)",
    mutate: (p) =>
      p
        .replace(
          "disobeying the task specification FM-1.1 is 11.8%",
          "disobeying the task specification FM-1.1 is 1.5%",
        )
        .replace(
          "disobeying the agent role FM-1.2 is 1.5%",
          "disobeying the agent role FM-1.2 is 11.8%",
        ),
    expectMissing: "fm-1-1-task-specification",
  },
];

/** A mutation that changed nothing is a mutant that proves nothing. */
export function assertMutates(name: string, original: string, mutated: string): void {
  if (original === mutated) {
    throw new Error(`defective mutant "${name}": its mutation is a no-op, so it proves nothing`);
  }
}

/**
 * Judge a copy of the §7 block: the labels of everything it fails to state,
 * correctly paired. Empty means the block says all of it and pairs it right.
 */
export function checkBlock(para: string): string[] {
  const misses: string[] = [];
  if (para.length <= 500) misses.push("block truncated");
  for (const fact of FACTS) if (!para.includes(fact.token)) misses.push(fact.label);

  const superIndex = para.indexOf("largest single");
  const scopeIndex = para.indexOf("FM-1.x");
  if (!(superIndex >= 0 && scopeIndex >= 0 && Math.abs(superIndex - scopeIndex) < 40))
    misses.push("superlative unscoped");
  if (!para.includes(SUPERLATIVE)) misses.push("canonical superlative");

  if (para.split("top-level").length - 1 !== 1) misses.push("top-level count");
  const positions = CATEGORY_ORDER.map((c) => para.indexOf(c));
  const topLevelIndex = para.indexOf("top-level");
  if (
    !(
      positions.every((p) => p >= 0) &&
      positions.every((p, i) => i === 0 || p > positions[i - 1]) &&
      positions.every((p) => p > topLevelIndex)
    )
  )
    misses.push("category order/scope");

  // The fabricated figure is a miss even when the true one survives elsewhere.
  if (para.includes("41.77")) misses.push("fabricated 41.77");
  return misses;
}

/** Whitespace-collapsed, bullet-stripped text: comments wrap, the WORDS do not. */
export function flatten(body: string): string {
  return body.replace(/^[ \t]*\*[ ]?/gm, "").replace(/\s+/g, " ");
}

/**
 * A file's NON-comment text — what a reader of a rendered surface actually sees.
 * The fabricated figure is legitimate in the provenance comment that explains
 * why it was removed; in an EMITTED string it is the bug, so the assertion that
 * keeps it out has to read the right layer.
 */
export function nonCommentText(body: string): string {
  return flatten(
    body
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n"),
  );
}

/**
 * The §7 step-back paragraph, located by heading token and read to the next
 * blank line — paragraph semantics, not one physical line. `AGENTS.md` is prose
 * that gets reflowed, and a locator bound to a single line narrows the gate the
 * moment the citation is broken into a continuation paragraph. An alternative
 * heading form (`## …`, the shape #408 found intent resolvers writing) counts
 * as the same locator, so a restyled block is found rather than missed.
 */
export function isStepBackHeading(line: string): boolean {
  return (
    line.startsWith(PARA_HEAD) ||
    line.startsWith(`## ${PARA_HEAD}`) ||
    line.startsWith(`### ${PARA_HEAD}`)
  );
}

export function stepBackParagraph(text: string): string | undefined {
  const lines = text.split("\n");
  const at = lines.findIndex(isStepBackHeading);
  if (at < 0) return undefined;
  const block = [lines[at]];
  for (let i = at + 1; i < lines.length && lines[i].trim() !== ""; i++) block.push(lines[i]);
  return block.join(" ");
}
