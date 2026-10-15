#!/usr/bin/env bun
/**
 * #407 — asking the project's documents instead of pattern-matching them.
 *
 * The gate this replaces was three English regexes over `AGENTS.md`, and the
 * two sentences below are the ones it got wrong **in production**, in opposite
 * directions. They are the first two tests here, verbatim:
 *
 *   1. lantern's `AGENTS.md:263` — *"Agents may squash-merge a PR to main once
 *      CI is green…"*. A real, deliberate grant. Matched nothing, because the
 *      pattern wanted `PRs` directly after `merge` and the indefinite article
 *      broke it. The operator was told merging was not permitted, and a
 *      finished cycle parked for no reason.
 *   2. this repo's own *"does **NOT** merge to main without explicit human
 *      approval"* — a real prohibition that escaped the deny matcher, which
 *      wanted `do not`, not `does not`.
 *
 * And a regex quietly assumes the operator writes English, which is why a
 * Finnish grant is in here too.
 *
 * The judge is faked — no live spawn — so this is offline. What is being
 * tested is the part that must never be wrong regardless of what the judge
 * says: that a claim only becomes permission when its citation checks out.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMergeAuthority } from "../src/work-driver-merge-authority.ts";
import {
  type DoctrineDoc,
  MERGE_POLICY_QUESTION,
  type PolicyAnswer,
  askPolicy,
  citationPresent,
  extractPolicyAnswer,
  policyPrompt,
} from "../src/work-driver-policy.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A judge that answers with a fixed `report_policy` call. */
const judgeSaying =
  (...answers: Partial<PolicyAnswer>[]) =>
  async () => ({
    toolUses: answers.map((a) => ({ name: "report_policy", arguments: a })),
  });

const docs = (text: string, file = "AGENTS.md"): DoctrineDoc[] => [{ file, text }];

// ------------------------------------- the two sentences the regexes got wrong

{
  // lantern AGENTS.md:263, verbatim. The regex missed this; the gate reported
  // `source: "none"` — indistinguishable from a project that said nothing.
  const LANTERN =
    "**Agent Merge Authorization**: Agents may squash-merge a PR to main once CI is green and the adversarial/review gate has approved — merging an approved, green PR is authorized for the pi-ensemble ops role.";
  const d = docs(`## 12. Agent policy\n\n${LANTERN}\n`);
  const decision = await askPolicy(
    judgeSaying({ verdict: "permitted", quote: LANTERN, sourceFile: "AGENTS.md" }),
    MERGE_POLICY_QUESTION,
    d,
  );
  assert(
    decision.permitted,
    "lantern's real grant resolves to PERMITTED — the regex missed it on 'a PR' vs 'PRs'",
  );
  assert(
    decision.sourceFile === "AGENTS.md" && (decision.quote ?? "").includes("squash-merge a PR"),
    "...and the verbatim sentence is persisted, so the operator can see what was relied on",
  );
}

{
  // This repo's own §9 spike-branch rule. `does not` escaped a matcher written
  // for `do not`, so a real prohibition was invisible.
  const DENY =
    "Experimental architectural work lives on a feature branch and does NOT merge to main without explicit human approval.";
  const decision = await askPolicy(
    judgeSaying({ verdict: "forbidden", quote: DENY, sourceFile: "AGENTS.md" }),
    MERGE_POLICY_QUESTION,
    docs(DENY),
  );
  assert(!decision.permitted, "'does NOT merge to main' is honoured as a prohibition");
  assert(decision.verdict === "forbidden", "...and recorded as forbidden, not merely unstated");
}

// ------------------------------------------------------------ any language

{
  const FI = "Agentit saavat yhdistää pull requestin main-haaraan itsenäisesti, kun CI on vihreä.";
  const decision = await askPolicy(
    judgeSaying({ verdict: "permitted", quote: FI, sourceFile: "AGENTS.md" }),
    MERGE_POLICY_QUESTION,
    docs(`# Ohjeet\n\n${FI}\n`),
  );
  assert(
    decision.permitted,
    "a Finnish grant resolves — no English regex could ever have read this file",
  );
}

// -------------------------------------------------- citation verification

{
  // The load-bearing case. A judge that says "permitted" and cites a sentence
  // that is not in the file has hallucinated a policy, and must not be obeyed.
  const decision = await askPolicy(
    judgeSaying({
      verdict: "permitted",
      quote: "Agents are allowed to merge pull requests whenever they judge it appropriate.",
      sourceFile: "AGENTS.md",
    }),
    MERGE_POLICY_QUESTION,
    docs("# Contributing\n\nOpen a PR and request review.\n"),
  );
  assert(!decision.permitted, "a FABRICATED quote does not grant authority");
  assert(decision.citationFailed === true, "...and is flagged as a citation failure");
  assert(
    /does not appear in/.test(decision.reason),
    "...with a reason that says the citation failed, not that the rule was missing",
  );
}
{
  const decision = await askPolicy(
    judgeSaying({ verdict: "permitted", sourceFile: "AGENTS.md" }),
    MERGE_POLICY_QUESTION,
    docs("Agents may merge.\n"),
  );
  assert(!decision.permitted, "'permitted' with NO quote at all is not a grant");
  assert(decision.citationFailed === true, "...also a citation failure");
}
{
  const decision = await askPolicy(
    judgeSaying({
      verdict: "permitted",
      quote: "Agents may merge once CI is green.",
      sourceFile: "POLICY.md",
    }),
    MERGE_POLICY_QUESTION,
    docs("Agents may merge once CI is green.\n"),
  );
  assert(
    !decision.permitted && decision.citationFailed === true,
    "citing a document that was never supplied fails, even when the sentence exists elsewhere",
  );
}

// A judge quoting honestly across formatting must still pass, or the gate is
// unusable on real markdown.
{
  const FILE = "## 9. Git workflow\n\nLLMs / agents are **allowed** to squash\nmerge PRs.\n";
  assert(
    citationPresent("LLMs / agents are allowed to squash merge PRs.", FILE),
    "a quote that drops bold markers and a line wrap still verifies — verbatim modulo formatting",
  );
  assert(
    !citationPresent("Agents may deploy to production.", FILE),
    "...but an invented sentence does not",
  );
  assert(!citationPresent("merge", FILE), "a trivially short 'quote' is not evidence");
}

// ------------------------------------------------------------- fails closed

{
  const nothing: DoctrineDoc[] = [];
  assert(
    !(await askPolicy(judgeSaying({ verdict: "permitted" }), "q", nothing)).permitted,
    "no doctrine documents → denied",
  );
  assert(
    !(await askPolicy(async () => undefined, MERGE_POLICY_QUESTION, docs("Agents may merge.")))
      .permitted,
    "a judge that returns nothing → denied",
  );
  assert(
    !(
      await askPolicy(
        async () => {
          throw new Error("spawn failed");
        },
        MERGE_POLICY_QUESTION,
        docs("Agents may merge."),
      )
    ).permitted,
    "a judge that throws → denied (an unavailable judge is not permission)",
  );
  assert(
    !(
      await askPolicy(
        async () => ({ toolUses: [] }),
        MERGE_POLICY_QUESTION,
        docs("Agents may merge."),
      )
    ).permitted,
    "no report_policy call at all → denied",
  );
  assert(
    !(await askPolicy(judgeSaying({ verdict: "unstated" }), "q", docs("x"))).permitted,
    "'unstated' → denied — the absence of a rule is not permission",
  );

  const prev = process.env.PI_ENSEMBLE_POLICY_JUDGE;
  process.env.PI_ENSEMBLE_POLICY_JUDGE = "0";
  const off = await askPolicy(
    judgeSaying({ verdict: "permitted", quote: "Agents may merge.", sourceFile: "AGENTS.md" }),
    MERGE_POLICY_QUESTION,
    docs("Agents may merge."),
  );
  assert(!off.permitted, "PI_ENSEMBLE_POLICY_JUDGE=0 denies rather than falling back to a guess");
  if (prev === undefined) delete process.env.PI_ENSEMBLE_POLICY_JUDGE;
  else process.env.PI_ENSEMBLE_POLICY_JUDGE = prev;
}

// ------------------------------------------------ the judge cannot equivocate

{
  const answer = extractPolicyAnswer([
    { name: "report_policy", arguments: { verdict: "permitted", quote: "Agents may merge." } },
    { name: "report_policy", arguments: { verdict: "forbidden", quote: "Never merge." } },
  ]);
  assert(
    answer?.verdict === "forbidden",
    "a judge that answers twice has its MOST RESTRICTIVE answer taken",
  );
  assert(
    extractPolicyAnswer([{ name: "report_finding", arguments: { verdict: "permitted" } }]) ===
      undefined,
    "a call to some other tool is not a policy answer",
  );
  assert(
    extractPolicyAnswer([{ name: "report_policy", arguments: { verdict: "yes please" } }]) ===
      undefined,
    "an out-of-schema verdict is discarded, not coerced",
  );
  assert(extractPolicyAnswer([]) === undefined, "no tool calls → no answer");
}

// -------------------------------------------- the judge sees no justification

{
  const prompt = policyPrompt(MERGE_POLICY_QUESTION, docs("Agents may merge once CI is green."));
  assert(
    prompt.includes("Agents may merge once CI is green."),
    "the prompt carries the doctrine text",
  );
  assert(
    /unsure/.test(prompt) && /Silence is not permission/.test(prompt),
    "...and instructs the judge to answer 'unstated' when unsure",
  );
  assert(
    /word for word/i.test(prompt),
    "...and demands a verbatim quote, since that is what gets verified",
  );
  assert(
    /description of a rule is not a rule/i.test(prompt),
    "...and warns that a quoted example is not a directive — what stripCode used to do for the regex",
  );
  // Structural, not textual: policyPrompt's signature admits a question and
  // documents. There is no parameter through which the developer's argument
  // for why it should be allowed could reach the judge.
  assert(policyPrompt.length === 2, "policyPrompt takes ONLY (question, docs) — by construction");
}

// -------------------------------- the durable tier is not repo-controlled

{
  const denyDoc = docs("Agents must never merge to main under any circumstances.");
  const operator = await resolveMergeAuthority(
    judgeSaying({ verdict: "forbidden", quote: "Agents must never merge to main" }),
    denyDoc,
    true,
  );
  assert(
    operator.granted && operator.source === "operator",
    "an in-session operator grant wins over the documents — the human IS the authority they protect",
  );

  const judged = await resolveMergeAuthority(
    judgeSaying({
      verdict: "permitted",
      quote: "Agents may merge once CI is green.",
      sourceFile: "AGENTS.md",
    }),
    docs("Agents may merge once CI is green."),
  );
  assert(judged.granted && judged.source === "doctrine", "a verified doctrine grant is honoured");

  const hallucinated = await resolveMergeAuthority(
    judgeSaying({ verdict: "permitted", quote: "Agents may merge.", sourceFile: "AGENTS.md" }),
    docs("Please ask a maintainer to merge on your behalf."),
    false,
  );
  assert(
    !hallucinated.granted && hallucinated.source === "citation-failed",
    "a failed citation is recorded as its own source, distinct from 'no rule found'",
  );
}

// ------------------------- #1308 S2 — the judge runs through the decision seam

{
  const root = mkdtempSync(path.join(os.tmpdir(), "policy-seam-"));
  const where = { repoRoot: root, issues: [42] };
  const log = () =>
    readFileSync(path.join(root, ".pi", "work-state", "42", "decisions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const fabricated = judgeSaying({
    verdict: "permitted",
    quote: "Agents may merge pull requests whenever they judge it right.",
    sourceFile: "AGENTS.md",
  });
  const HUMAN = docs("Please ask a maintainer to merge on your behalf.\n");
  const denied = await askPolicy(fabricated, MERGE_POLICY_QUESTION, HUMAN, where);
  assert(
    !denied.permitted && denied.citationFailed === true,
    "the judge says 'permitted' but the citation fails verification → denied",
  );
  const rec = log().at(-1);
  assert(
    rec?.seam === "policy-judge" &&
      rec.backends?.[0]?.answer === "permitted" &&
      rec.evidence?.passed === false &&
      rec.final?.answer === "unstated",
    "...and the seam's record shows the judge's 'permitted', the failed evidence and the deny",
  );

  const GRANT = "Agents may squash-merge a PR to main once CI is green.";
  const honest = judgeSaying({ verdict: "permitted", quote: GRANT, sourceFile: "AGENTS.md" });
  const saved = {
    d: process.env.PI_ENSEMBLE_DECISIONS,
    m: process.env.PI_ENSEMBLE_DECISION_MODE_POLICY_JUDGE,
  };
  process.env.PI_ENSEMBLE_DECISIONS = "0";
  const killed = await askPolicy(honest, MERGE_POLICY_QUESTION, docs(GRANT), where);
  assert(
    killed.permitted,
    "PI_ENSEMBLE_DECISIONS=0 does NOT change the judge — a verified grant is still honoured",
  );
  assert(
    !(await askPolicy(fabricated, MERGE_POLICY_QUESTION, HUMAN, where)).permitted,
    "...and a fabricated one is still denied",
  );
  delete process.env.PI_ENSEMBLE_DECISIONS;
  process.env.PI_ENSEMBLE_DECISION_MODE_POLICY_JUDGE = "shadow";
  assert(
    (await askPolicy(honest, MERGE_POLICY_QUESTION, docs(GRANT), where)).permitted,
    "the grandfathered judge ignores a per-seam mode override — only PI_ENSEMBLE_POLICY_JUDGE governs it",
  );
  if (saved.d === undefined) delete process.env.PI_ENSEMBLE_DECISIONS;
  else process.env.PI_ENSEMBLE_DECISIONS = saved.d;
  if (saved.m === undefined) delete process.env.PI_ENSEMBLE_DECISION_MODE_POLICY_JUDGE;
  else process.env.PI_ENSEMBLE_DECISION_MODE_POLICY_JUDGE = saved.m;
  assert(log().length === 4, "every judged call wrote exactly one decision-log record");
}

// ------------- #1308 review — decide() is the one verifier, and the bound is real

{
  // A prohibition needs no citation to be honoured: the outcome is still
  // 'forbidden', not a relabelled 'unstated'.
  const d = await askPolicy(
    judgeSaying({ verdict: "forbidden" }),
    MERGE_POLICY_QUESTION,
    docs("Agents may merge."),
  );
  assert(
    !d.permitted && d.verdict === "forbidden" && d.citationFailed !== true,
    "an uncited 'forbidden' is still a forbidden verdict, not a citation failure",
  );
}

{
  // decide()'s bound reaches the judge child: a judge still running at the
  // bound is aborted, and the cycle is denied.
  const root = mkdtempSync(path.join(os.tmpdir(), "policy-bound-"));
  const GRANT = "Agents may squash-merge a PR to main once CI is green.";
  let aborted = false;
  const wedged = (_p: string, signal?: AbortSignal) =>
    new Promise<undefined>((resolve) => {
      signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve(undefined);
        },
        { once: true },
      );
    });
  const d = await askPolicy(wedged, MERGE_POLICY_QUESTION, docs(GRANT), {
    repoRoot: root,
    issues: [43],
    timeoutMs: 40,
  });
  assert(!d.permitted && aborted, "a judge still running at the bound is ABORTED, and denied");

  // A verified grant that arrives after the bound is discarded, and traced.
  const warnings: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const late = async () => {
    await new Promise((r) => setTimeout(r, 120));
    return {
      toolUses: [
        {
          name: "report_policy",
          arguments: { verdict: "permitted", quote: GRANT, sourceFile: "AGENTS.md" },
        },
      ],
    };
  };
  const late2 = await askPolicy(late, MERGE_POLICY_QUESTION, docs(GRANT), {
    repoRoot: root,
    issues: [44],
    timeoutMs: 20,
  });
  await new Promise((r) => setTimeout(r, 200));
  process.stderr.write = realWrite;
  assert(
    !late2.permitted,
    "a judge answering AFTER the bound is not honoured, even with a verified grant",
  );
  assert(
    warnings.some((w) => /settled after its 20ms bound/.test(w)),
    "...and the late answer is traced, not silently dropped",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
