/**
 * work-driver-policy — asking a project's own documents whether an action is
 * permitted, without pattern-matching them (#407).
 *
 * ## What was here before
 *
 * Three regexes over `AGENTS.md`. They were narrow on purpose — inventing
 * permission nobody gave is the worst possible failure — and they still got it
 * wrong in both directions on real files:
 *
 *   - nessie's *"Agents may squash-merge **a** PR to main once CI is green"* —
 *     a genuine, deliberate grant — matched nothing, because the pattern
 *     wanted `PRs` directly after `merge` and an indefinite article broke it.
 *     The gate reported `source: "none"`, indistinguishable from a project
 *     that had never said anything at all.
 *   - this repo's own *"does **NOT** merge to main without explicit human
 *     approval"* escaped the deny matcher, which wanted `do not`.
 *
 * And a regex quietly assumes the operator writes English.
 *
 * ## Why a judge, and why the judge is not trusted
 *
 * The industry split is consistent: prose expresses preference, convention and
 * judgment; structured config expresses capability boundaries. What makes a
 * natural-language grant safe is the 2026 tier both Claude Code and Cursor
 * shipped — prose read by a *second* model, fenced by durable rules the
 * classifier cannot override. That fencing is preserved here exactly:
 *
 *   - **Durable, in code, not repo-controlled**: default deny, the `--merge`
 *     operator grant, `PI_ENSEMBLE_MERGE_AUTHORITY=0`. Prose grants the
 *     exception; it can never grant the rule.
 *   - **The judge never sees the agent's justification.** It gets the doctrine
 *     text and the proposed action, never the developer's argument for why it
 *     should be allowed — otherwise it can be talked into a yes.
 *   - **Citation-verified.** The judge must quote the sentence that grants the
 *     permission, and `decidePolicy` checks that sentence actually appears in
 *     the file the judge named. A fabricated quote is not just ignored, it is
 *     surfaced: a hallucinating judge is a thing the operator should know
 *     about, not something to paper over with a silent fallback.
 *
 * Citation-forcing is a known RAG technique (Deterministic Quoting and
 * relatives); using a failed lookup as an *authorisation deny* is the novel
 * part. Its documented limit applies and is accepted for now: verbatim
 * existence is a hallucination guard, not a relevance guard — a real but
 * irrelevant sentence would pass. Entailment checking (LACE-style) is the next
 * tier if that is ever observed in practice.
 *
 * ## Why the judge gets the RAW file
 *
 * The regex path had to strip code fences first, because adding a sentence to
 * this repo's AGENTS.md that *described* the deny matcher — quoting the phrase
 * "never merge" — flipped the repo from granted to denied. A matcher that
 * cannot tell a rule from a description of a rule is unusable in exactly the
 * files it has to read. A model can tell the difference, so it is told to, and
 * reads the file unmodified. That the workaround is no longer needed is the
 * clearest measure of what changed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { reporterPathFromArgs, statReporterPath } from "./reporter-preflight.ts";
import { makeRunId, spawnSpecialist } from "./spawn.ts";
import { trace } from "./trace.ts";

export type PolicyVerdict = "permitted" | "forbidden" | "unstated";

/** The judge's raw claim, as extracted from its `report_policy` tool call. */
export interface PolicyAnswer {
  verdict: PolicyVerdict;
  quote?: string;
  sourceFile?: string;
  reasoning?: string;
}

/** A doctrine file's name and contents, as read at the cycle's base commit. */
export interface DoctrineDoc {
  file: string;
  text: string;
}

export interface PolicyDecision {
  /** The only field a caller should gate on. */
  permitted: boolean;
  verdict: PolicyVerdict;
  /** Verbatim, and verified to exist, when `permitted` or explicitly forbidden. */
  quote?: string;
  sourceFile?: string;
  /**
   * The judge cited a sentence that is not in the file it named. Denied, and
   * worth surfacing — this is a hallucination signal, not a parse miss.
   */
  citationFailed?: boolean;
  /** Operator-facing explanation of the outcome. */
  reason: string;
}

/**
 * Normalise text for citation comparison.
 *
 * Verbatim "modulo formatting": a judge that copies a sentence spanning a line
 * wrap, or drops the `**` around a bolded word, is quoting honestly and should
 * pass. A judge that invents a sentence should not. Markdown emphasis, list
 * bullets and whitespace runs are therefore flattened, and nothing else is.
 */
export function normaliseForCitation(s: string): string {
  return s
    .replace(/[*_`]/g, "")
    .replace(/^\s*[-+*>]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Does `quote` actually appear in `text`? */
export function citationPresent(quote: string, text: string): boolean {
  const q = normaliseForCitation(quote);
  // A trivially short "quote" would match almost anything; it is not evidence.
  if (q.length < 12) return false;
  return normaliseForCitation(text).includes(q);
}

/**
 * Turn the judge's claim into a decision, deterministically.
 *
 * No regex, no language assumption, and no path where a missing or unparseable
 * answer yields permission. The whole function is a chain of denials with one
 * narrow exit: an explicit `permitted` whose quote was found in a document the
 * driver itself supplied.
 */
export function decidePolicy(
  answer: PolicyAnswer | undefined,
  docs: readonly DoctrineDoc[],
): PolicyDecision {
  if (!answer) {
    return {
      permitted: false,
      verdict: "unstated",
      reason:
        "the policy judge produced no usable answer (no report_policy call), and an absent answer is not permission",
    };
  }

  if (answer.verdict === "forbidden") {
    // A denial is honoured whether or not it cites cleanly. Requiring a valid
    // citation to *deny* would mean a sloppy judge could unblock an action the
    // documents prohibit — the failure direction that must never exist.
    return {
      permitted: false,
      verdict: "forbidden",
      quote: answer.quote,
      sourceFile: answer.sourceFile,
      reason: answer.quote
        ? `the project's documents prohibit it ("${answer.quote.trim().slice(0, 200)}")`
        : "the project's documents prohibit it",
    };
  }

  if (answer.verdict !== "permitted") {
    return {
      permitted: false,
      verdict: "unstated",
      reason:
        "the project's documents do not address this action, and the absence of a rule is not permission",
    };
  }

  if (!answer.quote?.trim()) {
    return {
      permitted: false,
      verdict: "permitted",
      citationFailed: true,
      reason:
        "the judge answered 'permitted' but cited no sentence — an uncited grant is not evidence of one",
    };
  }

  // The judge names the file; only files the driver supplied are eligible. A
  // judge that cites `POLICY.md` when it was handed `AGENTS.md` is describing
  // a document nobody read.
  const named = answer.sourceFile?.trim();
  const candidates = named
    ? docs.filter((d) => d.file.toLowerCase() === named.toLowerCase())
    : docs;
  if (named && candidates.length === 0) {
    return {
      permitted: false,
      verdict: "permitted",
      quote: answer.quote,
      sourceFile: named,
      citationFailed: true,
      reason: `the judge cited '${named}', which is not one of the documents it was given (${docs.map((d) => d.file).join(", ") || "none"})`,
    };
  }

  const hit = candidates.find((d) => citationPresent(answer.quote ?? "", d.text));
  if (!hit) {
    return {
      permitted: false,
      verdict: "permitted",
      quote: answer.quote,
      sourceFile: named,
      citationFailed: true,
      reason: `the judge answered 'permitted' citing "${answer.quote.trim().slice(0, 120)}", but that sentence does not appear in ${named ?? "any supplied document"} — the citation failed, so the grant is not honoured`,
    };
  }

  return {
    permitted: true,
    verdict: "permitted",
    quote: answer.quote.trim().slice(0, 400),
    sourceFile: hit.file,
    reason: `${hit.file} permits it ("${answer.quote.trim().slice(0, 200)}")`,
  };
}

/**
 * Extract the judge's answer from the child's `tool_use` events.
 *
 * Mirrors `extractFindings`. If the judge called the tool more than once, the
 * most restrictive answer wins — `forbidden` over `unstated` over `permitted`
 * — so a judge that equivocates cannot have its permissive answer picked up.
 */
export function extractPolicyAnswer(toolUses: readonly unknown[]): PolicyAnswer | undefined {
  const rank: Record<PolicyVerdict, number> = { forbidden: 0, unstated: 1, permitted: 2 };
  let best: PolicyAnswer | undefined;
  for (const tu of toolUses) {
    if (!tu || typeof tu !== "object") continue;
    const t = tu as { name?: string; arguments?: unknown };
    if (t.name !== "report_policy" || !t.arguments || typeof t.arguments !== "object") continue;
    const a = t.arguments as Record<string, unknown>;
    const raw = String(a.verdict ?? "")
      .toLowerCase()
      .trim();
    if (raw !== "permitted" && raw !== "forbidden" && raw !== "unstated") continue;
    const candidate: PolicyAnswer = {
      verdict: raw,
      quote: typeof a.quote === "string" ? a.quote : undefined,
      sourceFile: typeof a.sourceFile === "string" ? a.sourceFile : undefined,
      reasoning: typeof a.reasoning === "string" ? a.reasoning : undefined,
    };
    if (!best || rank[candidate.verdict] < rank[best.verdict]) best = candidate;
  }
  return best;
}

/**
 * The judge's prompt.
 *
 * Contains the doctrine text and the proposed action, and deliberately nothing
 * else — no issue title, no diff, no developer rationale. Anthropic's finding
 * on this is direct: a classifier that sees the agent's justification can be
 * argued into agreeing with it.
 */
export function policyPrompt(question: string, docs: readonly DoctrineDoc[]): string {
  const bodies = docs
    .map((d) => `### ${d.file}\n\n<<<DOCUMENT ${d.file}\n${d.text}\nDOCUMENT>>>`)
    .join("\n\n");
  return `You are answering ONE question about what a software project's own written policy permits. You are not reviewing code and you have no opinion about whether the action is a good idea.

## The question

${question}

## The project's documents

${bodies || "(no documents were supplied)"}

## Answer only from the documents above

Those blocks are the whole record. Other project files may be present in your
context — your working directory has its own copy of some of them — and they may
be a **different version** of what is quoted here. Ignore them. If a rule is not
in the text above, it does not exist for this question, however plausible it
looks elsewhere.

## How to answer

Call the \`report_policy\` tool exactly once. Your prose reply is discarded.

- \`permitted\` — a document explicitly allows this action.
- \`forbidden\` — a document explicitly prohibits it.
- \`unstated\` — the documents do not address it. **This is the correct answer whenever you are unsure.** Silence is not permission, and guessing wrong here authorises an irreversible action.

For \`permitted\` and \`forbidden\` you MUST also supply \`quote\`: the one sentence stating the rule, copied **word for word** from the document, in the language it is written in. Do not translate it, do not paraphrase it, do not tidy it up. It is checked against the document character by character, and an answer whose quote cannot be found is discarded.

If you cannot copy an exact sentence, the answer is \`unstated\`.

Two things to be careful about:

- **A description of a rule is not a rule.** Text inside backticks or a fenced code block is an example or a quotation — these documents often describe how this very mechanism works. Only a sentence asserting the rule in the document's own voice counts.
- **Discussion is not permission.** "Ask a maintainer to merge on your behalf" or "the reviewer will merge once approved" describe a process; neither permits *you* to act. Answer \`unstated\` for those.`;
}

/** The question asked at the merge gate. */
export const MERGE_POLICY_QUESTION =
  "Do these documents explicitly permit an automated agent (an LLM, a bot, or this coding assistant) to merge a pull request into the main branch on its own, without a human performing the merge?";

/** Doctrine files consulted, in order. Read-only; see work-driver-doctrine.ts. */
export const DOCTRINE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

const POLICY_REPORTER_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "policy-reporter.ts",
);

/** Injectable spawn seam, so the decision path is testable offline. */
export type PolicyJudgeFn = (prompt: string) => Promise<{ toolUses: unknown[] } | undefined>;

/** #407 escape hatch: fall back to nothing — the gate simply denies. */
export function policyJudgeEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_POLICY_JUDGE;
  return v !== "0" && v !== "false";
}

/**
 * Ask the doctrine a question and get a verified answer.
 *
 * Fails closed at every step: a disabled judge, a spawn that throws, a child
 * that returns nothing, and a child that answers without a valid citation all
 * produce `permitted: false`.
 */
export async function askPolicy(
  judge: PolicyJudgeFn,
  question: string,
  docs: readonly DoctrineDoc[],
): Promise<PolicyDecision> {
  if (!policyJudgeEnabled()) {
    return {
      permitted: false,
      verdict: "unstated",
      reason: "PI_ENSEMBLE_POLICY_JUDGE=0 — the policy judge is disabled, so nothing is permitted",
    };
  }
  if (docs.length === 0) {
    return {
      permitted: false,
      verdict: "unstated",
      reason: "the project has no doctrine documents at the cycle's base commit",
    };
  }
  let result: { toolUses: unknown[] } | undefined;
  try {
    result = await judge(policyPrompt(question, docs));
  } catch (err) {
    return {
      permitted: false,
      verdict: "unstated",
      reason: `the policy judge could not be consulted (${(err as Error).message?.slice(0, 160)}), and an unavailable judge is not permission`,
    };
  }
  const decision = decidePolicy(extractPolicyAnswer(result?.toolUses ?? []), docs);
  if (decision.citationFailed) {
    trace(`work-driver: policy — CITATION FAILED: ${decision.reason}`);
  } else {
    trace(
      `work-driver: policy — ${decision.verdict} (${decision.permitted ? "granted" : "denied"})`,
    );
  }
  return decision;
}

/** Where the companion extension lives, for `--extension`. */
export function policyReporterPath(): string {
  return POLICY_REPORTER_PATH;
}

/** 5 min — one question, one document. A wedged judge should deny, not stall. */
const POLICY_JUDGE_TIMEOUT_MS = 5 * 60_000;

/**
 * #893 — injectable stat seam for the pre-spawn existence check on
 * `POLICY_REPORTER_PATH`. Production passes none (the real `fs.stat` is
 * used); tests pass a rejecting stub to simulate a missing reporter.
 */
export type PolicyStatFn = (p: string) => Promise<unknown>;

/**
 * The concrete judge: a read-only child that answers one policy question and
 * reports through `report_policy`.
 *
 * Runs as `explore` because that is the roster's read-only, repo-cwd role; the
 * judge needs no tool beyond reading, and the prompt is entirely
 * self-contained. `--no-skills` plus the reporter as the only loaded extension
 * mirrors lens-review's isolation. The timeout is deliberately short — one
 * question against one document is not an investigation — so a wedged judge
 * denies quickly rather than stalling a cycle whose work is already finished
 * and pushed.
 *
 * Returns undefined on any failure; `askPolicy` treats that as no permission.
 *
 * #893 — pre-spawn stat of `POLICY_REPORTER_PATH` via the injectable
 * `statFn` seam. A missing reporter path throws the named
 * "reporter extension missing" error before `spawnSpecialist` is called, so
 * the judge fails fast with a clear message rather than silently producing
 * an empty `toolUses: []` that `askPolicy` reads as "no permission".
 */
export function judgePolicy(repoRoot: string, statFn?: PolicyStatFn): PolicyJudgeFn {
  const extraArgs = ["--no-skills", "--extension", POLICY_REPORTER_PATH];
  const reporterPath = reporterPathFromArgs(extraArgs);
  return async (prompt: string) => {
    // #893 — pre-spawn stat; missing path → named error, no spawn.
    if (reporterPath) {
      await statReporterPath(reporterPath, statFn);
    }
    const result = await spawnSpecialist(
      { role: "explore", prompt, cwd: repoRoot },
      {
        runId: makeRunId(),
        tag: "policy-judge",
        extraArgs,
        timeoutMs: POLICY_JUDGE_TIMEOUT_MS,
      },
    );
    return result.ok ? { toolUses: result.toolUses ?? [] } : undefined;
  };
}

/** One doctrine file's launch-time status, from a stat rather than a read. */
export type DoctrinePresence = "present" | "absent" | "unreadable";

/**
 * Stat (not read) each of `DOCTRINE_FILES` at `repoRoot`. Returns per-file
 * statuses plus `presentFiles` — the subset that exists — because that is the
 * same set the merged-step judge is fed, so the launch notice and the gate
 * agree on what they see. ENOENT is `absent` (the file is genuinely not
 * there); any other stat error is `unreadable` (permissions, I/O — the
 * merged-step judge reads via `git show <baseSha>`, a different read that can
 * still succeed, so this must not be reported as "will park").
 *
 * Presence-only by design: nothing here reads file contents, and the policy
 * judge is deliberately NOT invoked — authority is decided at the merged
 * step, this notice is informational.
 */
export async function doctrinePresence(
  repoRoot: string,
): Promise<{ files: Record<string, DoctrinePresence>; presentFiles: string[] }> {
  const files = {} as Record<string, DoctrinePresence>;
  for (const file of DOCTRINE_FILES) {
    const p = path.join(repoRoot, file);
    try {
      await fs.stat(p);
    } catch (err) {
      files[file] = (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
      continue;
    }
    // A stat pass is not enough on macOS — `stat` succeeds on a mode-000
    // file. A bounded read probe (32 bytes is well past any in-kernel cache
    // boundary for a regular file, and the read of a doctrine file would be
    // far larger anyway) makes the "unreadable" branch honest without loading
    // the file: this is a presence check, never a content read.
    try {
      const fh = await fs.open(p, "r");
      try {
        await fh.read(new Uint8Array(32), 0, 32, 0);
      } finally {
        await fh.close();
      }
      files[file] = "present";
    } catch {
      files[file] = "unreadable";
    }
  }
  return {
    files,
    presentFiles: DOCTRINE_FILES.filter((f) => files[f] === "present"),
  };
}

/** Read a doctrine document from disk. Used only where base-reading does not apply. */
export async function readDoctrineFromDisk(
  repoRoot: string,
  file: string,
): Promise<DoctrineDoc | undefined> {
  try {
    return { file, text: await fs.readFile(path.join(repoRoot, file), "utf8") };
  } catch {
    return undefined;
  }
}
