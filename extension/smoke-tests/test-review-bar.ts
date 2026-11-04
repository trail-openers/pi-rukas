#!/usr/bin/env bun
/**
 * The review blocking bar: which severity stops a merge, and where the answer
 * comes from.
 *
 * A lens assigns a finding's severity; the project decides which severity
 * blocks. The rule differs from merge authority ON PURPOSE: authority fails
 * closed, configuration falls back to the shipped default — because a repo with
 * no `AGENTS.md` at all is the normal case, not an error.
 *
 * **The shipped default is HIGH** (`DEFAULT_REVIEW_THRESHOLD`), which is also
 * this repo's own bar. At a MEDIUM default the overwhelming majority of
 * repositories — those that state no bar anywhere — had ordinary best-practice
 * findings turned into fix orders. Lowering is the project's decision through a
 * citation-verified sentence, and `PI_ENSEMBLE_REVIEW_THRESHOLD` overrides
 * everything for one run.
 *
 * Split out of `test-lens-evidence.ts` (AGENTS.md §12's file-size gate): that
 * suite owns evidence supply, this one owns the bar. Shared helpers — the
 * counted assertion and the §1 sentence locator — live in
 * `lib/review-bar-helpers.ts` so the two suites cannot disagree about what §1
 * says.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_REVIEW_THRESHOLD, computeVerdict } from "../src/lens-review-format.ts";
import {
  isBlockingSeverity,
  resolveReviewThreshold,
  severityFromQuote,
} from "../src/review-threshold.ts";
import { DEFAULT_REVIEW_THRESHOLD as RESOLVER_DEFAULT } from "../src/review-severity-default.ts";
import { type DoctrineDoc, policyJudgeEnabled } from "../src/work-driver-policy.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  HIGH_BAR,
  assert,
  docs,
  failureCount,
  mkFinding as mk,
  ownBlockingSentences,
  repoRoot,
} from "./lib/review-bar-helpers.ts";

// The stub is the ONLY backend on this path: `askPolicy` builds one backend
// named "policy-judge" whose `run` calls the injected `judge`, and `decide()`
// uses `ctx.backends` verbatim — the grandfathered branch that would otherwise
// refuse the generic classifier/session-LLM backends is only reached when a
// caller supplies none (decision-seam.ts). So nothing here spawns a child
// process: the whole file is offline.
const judgeSaying = (a: Record<string, unknown> | undefined) => async () => ({
  toolUses: a ? [{ name: "report_policy", arguments: a }] : [],
});

{
  assert(
    DEFAULT_REVIEW_THRESHOLD === "HIGH",
    "the shipped default is HIGH — a repo whose doctrine says nothing must not turn best-practice findings into fix orders",
  );
  assert(
    RESOLVER_DEFAULT === DEFAULT_REVIEW_THRESHOLD,
    "the bar has ONE definition: the constant re-exported by the format leaf is the one the resolver defaults to",
  );
  assert(
    computeVerdict([mk("MEDIUM")], []) === "APPROVED",
    "by default a MEDIUM finding is disclosed, not a fix order — the defect this default exists to stop",
  );
  assert(
    computeVerdict([mk("HIGH")], []) === "ISSUES_FOUND",
    "by default a HIGH finding blocks — the default is the bar, not an absence of one",
  );
  assert(
    computeVerdict([mk("MEDIUM")], [], "HIGH") === "APPROVED",
    "a project that sets HIGH lets a MEDIUM through",
  );
  assert(computeVerdict([mk("HIGH")], [], "HIGH") === "ISSUES_FOUND", "...but not a HIGH");
  assert(
    computeVerdict([mk("LOW")], [], "LOW") === "ISSUES_FOUND",
    "a project may tighten to LOW and block on everything",
  );
  assert(
    computeVerdict([mk("LOW")], []) === "APPROVED",
    "a LOW alone still approves by default",
  );
  assert(
    computeVerdict([mk("CRITICAL")], [], "LOW") === "CRITICAL_ISSUES_FOUND",
    "CRITICAL blocks whatever the threshold says — no project gets to wave one through",
  );
  // `bar` is a REQUIRED argument (`isBlockingSeverity(severity, bar)`), so there
  // is no default bar to drift. The arm that matters is the unrankable one: a
  // caller reads severities off serialised JSON, and a row it cannot rank must
  // never be evidence that nothing blocks.
  assert(
    isBlockingSeverity(undefined, "HIGH") === true,
    "an unrankable severity at a HIGH bar fails closed — an unreadable row is never 'nothing blocks'",
  );
  assert(
    isBlockingSeverity("BLOCKER", "HIGH") === true,
    "an unknown severity string fails closed whatever the bar",
  );
  assert(
    isBlockingSeverity(undefined, "CRITICAL") === true,
    "…and the same at the strictest bar",
  );
  assert(
    isBlockingSeverity("MEDIUM", "HIGH") === false,
    "a rankable sub-bar row does not block at HIGH",
  );
}

// ------------------------- resolution: absent doctrine is normal, not an error

{
  const none = await resolveReviewThreshold(judgeSaying(undefined), []);
  assert(
    none.severity === "HIGH" && none.source === "default",
    "NO AGENTS.md at all → HIGH. A repo without doctrine is the normal case, not a failure",
  );

  const silent = await resolveReviewThreshold(
    judgeSaying({ verdict: "unstated" }),
    docs("# Contributing\n\nRun the tests.\n"),
  );
  assert(
    silent.severity === "HIGH" && silent.source === "default",
    "doctrine that never mentions review severity → HIGH",
  );

  // A verified MEDIUM bar still WINS over the HIGH default: the project said
  // MEDIUM blocks, and a default does not over-rule a stated bar by tightening
  // it.
  const MEDIUM_SENT = "Six-pass review findings are blocking at MEDIUM severity and above.";
  const loosened = await resolveReviewThreshold(
    judgeSaying({ verdict: "permitted", quote: MEDIUM_SENT, sourceFile: "AGENTS.md" }),
    docs(`## 1. Gates\n\n${MEDIUM_SENT}\n`),
  );
  assert(
    loosened.severity === "MEDIUM" && loosened.source === "doctrine",
    `a project whose verified sentence says MEDIUM gets MEDIUM, not the HIGH default (got ${loosened.severity}/${loosened.source})`,
  );
  const LOW_SENT = "Findings of LOW severity and above are blocking.";
  const tightened = await resolveReviewThreshold(
    judgeSaying({ verdict: "permitted", quote: LOW_SENT, sourceFile: "AGENTS.md" }),
    docs(`## 1. Gates\n\n${LOW_SENT}\n`),
  );
  assert(
    tightened.severity === "LOW" && tightened.source === "doctrine",
    `a project that tightens to LOW gets LOW, whatever the default says (got ${tightened.severity}/${tightened.source})`,
  );

  const SENT = "Six-pass review findings are blocking at HIGH severity and above.";
  const set = await resolveReviewThreshold(
    judgeSaying({ verdict: "permitted", quote: SENT, sourceFile: "AGENTS.md" }),
    docs(`## 1. Gates\n\n${SENT}\n`),
  );
  assert(
    set.severity === "HIGH" && set.source === "doctrine",
    "a project that states HIGH gets HIGH, with the sentence recorded",
  );
  assert(set.quote === SENT, "...verbatim");

  // The #407 citation check carries straight over: an invented sentence cannot
  // loosen the bar.
  const fabricated = await resolveReviewThreshold(
    judgeSaying({
      verdict: "permitted",
      quote: "Only CRITICAL findings block a merge in this project.",
      sourceFile: "AGENTS.md",
    }),
    docs("# Contributing\n\nRun the tests.\n"),
  );
  assert(
    fabricated.severity === "HIGH" && fabricated.source === "default",
    "a FABRICATED sentence cannot loosen the bar — the citation must exist, and the default is HIGH",
  );

  const prev = process.env.PI_ENSEMBLE_REVIEW_THRESHOLD;
  process.env.PI_ENSEMBLE_REVIEW_THRESHOLD = "critical";
  const op = await resolveReviewThreshold(judgeSaying({ verdict: "unstated" }), docs("x"));
  assert(
    op.severity === "CRITICAL" && op.source === "operator",
    "the operator's env override wins, case-insensitively",
  );
  process.env.PI_ENSEMBLE_REVIEW_THRESHOLD = "nonsense";
  assert(
    (await resolveReviewThreshold(judgeSaying({ verdict: "unstated" }), docs("x"))).severity ===
      "HIGH",
    "a nonsense override is ignored rather than obeyed",
  );
  if (prev === undefined) delete process.env.PI_ENSEMBLE_REVIEW_THRESHOLD;
  else process.env.PI_ENSEMBLE_REVIEW_THRESHOLD = prev;
}

// -------------------- a disabled judge resolves to the HIGH default, directly

{
  // Distinct from the `policyJudgeEnabled()` guard above, which only asserts the
  // judge is ON so the blocks below cannot pass for the wrong reason. This is the
  // other direction, run under `withEnv` so the variable cannot leak: with the
  // judge switched off, doctrine cannot be read at all, so even a project whose
  // AGENTS.md states a bar resolves to the shipped HIGH default rather than to
  // an error or to the project's own answer.
  const doctrineThatStatesALowBar =
    "## 1. Gates\n\nFindings of LOW severity and above are blocking.\n";
  await withEnv({ PI_ENSEMBLE_POLICY_JUDGE: "0" }, async () => {
    assert(
      !policyJudgeEnabled(),
      "the judge really is off inside this block — otherwise the assertion below would be the doctrine case, not the disabled case",
    );
    const disabled = await resolveReviewThreshold(
      judgeSaying({ verdict: "permitted", quote: "x", sourceFile: "AGENTS.md" }),
      docs(doctrineThatStatesALowBar),
    );
    assert(
      disabled.severity === "HIGH" && disabled.source === "default",
      `PI_ENSEMBLE_POLICY_JUDGE=0 → severity HIGH / source default, whatever the doctrine says (got ${disabled.severity}/${disabled.source})`,
    );
  });
}

// --------------------------------- this repo's own AGENTS.md §1, end to end

{
  const text = await fs.readFile(path.join(repoRoot(), "AGENTS.md"), "utf8");
  assert(
    /blocking at HIGH severity and above/i.test(text),
    "pi-ensemble's own AGENTS.md states HIGH — the sentence the code now reads",
  );
  // The code default is the same value this repo's operator decision chose:
  // silent doctrine still gets HIGH, asserted above in the resolution block.
  const sentences = ownBlockingSentences(text);
  assert(sentences.length > 0, "§1's threshold paragraph is present");
  const OWN_QUOTE = sentences.find((s) => HIGH_BAR.test(s));
  assert(OWN_QUOTE !== undefined, "§1's blocking sentence is found verbatim in AGENTS.md");
  // Negative direction: no single sentence of §1's threshold paragraph may read
  // as a LOOSER bar than HIGH. A sentence that says MEDIUM or LOW blocks would
  // silently lower the gate the judge is chartered to read. And at least two
  // sentences must carry the bar themselves — if §1 ever degenerates to a
  // single relational sentence plus prose, a judge quoting the other one lands
  // on the default by accident, and a loop that only rejects looser bars cannot
  // notice that.
  let barSentences = 0;
  for (const sentence of sentences) {
    const got = severityFromQuote(sentence);
    assert(
      got === "HIGH" || got === undefined,
      `sentence "${sentence.slice(0, 60)}…" reads as HIGH or nothing (got ${got}) — never a looser bar`,
    );
    if (got === "HIGH") barSentences++;
  }
  assert(
    barSentences >= 2,
    `at least two sentences of §1's threshold paragraph resolve to HIGH (got ${barSentences}) — a judge quoting either one must land on HIGH, not merely on the HIGH default`,
  );
  const own = await resolveReviewThreshold(
    judgeSaying({
      verdict: "permitted",
      quote: OWN_QUOTE,
      sourceFile: "AGENTS.md",
    }),
    docs(text),
  );
  assert(
    own.severity === "HIGH" && own.source === "doctrine",
    `resolving this repository's own AGENTS.md yields HIGH (got ${own.severity}/${own.source})`,
  );

  // Mirror 1 over the REAL doctrine: a judge that reads the same file and says
  // nothing stays on the default — HIGH doctrine does not leak into an answer
  // the judge did not give.
  const ownSilent = await resolveReviewThreshold(judgeSaying({ verdict: "unstated" }), docs(text));
  assert(
    ownSilent.severity === "HIGH" && ownSilent.source === "default",
    `the same AGENTS.md with an 'unstated' judge yields HIGH/default (got ${ownSilent.severity}/${ownSilent.source}) — doctrine is only honoured through a verified citation`,
  );

  // Mirror 2: a judge that quotes the retired MEDIUM bar, a sentence this repo's
  // AGENTS.md does not contain. It must not be honoured — the #407 citation
  // check over the real file is what stops it, not a literal in this test.
  const ownFabricated = await resolveReviewThreshold(
    judgeSaying({
      verdict: "permitted",
      quote: "Six-pass review findings are blocking at MEDIUM severity and above.",
      sourceFile: "AGENTS.md",
    }),
    docs(text),
  );
  assert(
    ownFabricated.severity === "HIGH" && ownFabricated.source !== "doctrine",
    `a quote of the retired MEDIUM sentence, absent from AGENTS.md, is not honoured (got ${ownFabricated.severity}/${ownFabricated.source})`,
  );
}

// ------------------- the verified quote decides the bar, not the judge's label

{
  // The follow-up defect in #1988, observed on a real headless proof run: the
  // judge answered `forbidden` while quoting §1's HIGH sentence VERBATIM, with
  // the citation verified. `resolveReviewThreshold` gated the bar on
  // `decision.permitted`, which is false for every `forbidden` answer whatever
  // its citation, so the bar silently fell to the default and a round with only
  // sub-bar findings bought a fix wave.
  //
  // With the judge disabled, `askPolicy` denies before the stub is called and
  // every resolution below falls to the default — exactly the shape these
  // assertions must NOT silently pass on. Fail loudly instead.
  assert(
    policyJudgeEnabled(),
    "the policy judge is enabled (PI_ENSEMBLE_POLICY_JUDGE unset) — with it off every resolution here would fall to the default and pass for the wrong reason",
  );

  const ownDoctrine = await fs.readFile(path.join(repoRoot(), "AGENTS.md"), "utf8");
  const HIGH_SENTENCE = ownBlockingSentences(ownDoctrine).find((s) => HIGH_BAR.test(s)) ?? "";

  // Case 1 — the judge's `forbidden` label carries a quote the seam verified:
  // it still decides HIGH. Proves the bar comes from the citation, not `permitted`.
  const forbiddenVerified = await resolveReviewThreshold(
    judgeSaying({ verdict: "forbidden", quote: HIGH_SENTENCE, sourceFile: "AGENTS.md" }),
    docs(ownDoctrine),
  );
  assert(
    forbiddenVerified.severity === "HIGH" && forbiddenVerified.source === "doctrine",
    `a citation-VERIFIED 'forbidden' that quotes §1's HIGH sentence decides HIGH, label notwithstanding (got ${forbiddenVerified.severity}/${forbiddenVerified.source}) — the label is not the bar`,
  );
  assert(
    forbiddenVerified.quote === HIGH_SENTENCE,
    `...and the sentence relied on is recorded verbatim (got ${String(forbiddenVerified.quote).slice(0, 60)})`,
  );

  // Case 2 — the same label quoting a sentence the documents do not contain.
  // Verification is what decided case 1, so an unverified quote falls to the
  // default whatever the label says.
  const forbiddenUnverified = await resolveReviewThreshold(
    judgeSaying({
      verdict: "forbidden",
      quote: "Six-pass review findings are blocking at LOW severity and above.",
      sourceFile: "AGENTS.md",
    }),
    docs(ownDoctrine),
  );
  assert(
    forbiddenUnverified.severity === "HIGH" && forbiddenUnverified.source === "default",
    `an UNVERIFIED quote under a 'forbidden' label still yields the default (got ${forbiddenUnverified.severity}/${forbiddenUnverified.source}) — a sentence the documents lack decides nothing`,
  );

  // Case 3 — a `forbidden` with NO quote: there is no sentence to read a bar
  // off, so the default stands. Proves the bar comes from a quote and never
  // from the verdict alone.
  const forbiddenNoQuote = await resolveReviewThreshold(
    judgeSaying({ verdict: "forbidden", sourceFile: "AGENTS.md" }),
    docs(ownDoctrine),
  );
  assert(
    forbiddenNoQuote.severity === "HIGH" && forbiddenNoQuote.source === "default",
    `a 'forbidden' with NO quote yields the default (got ${forbiddenNoQuote.severity}/${forbiddenNoQuote.source})`,
  );
}

console.log(`\nexit ${failureCount() === 0 ? 0 : 1}`);
process.exit(failureCount() === 0 ? 0 : 1);
