/**
 * #1129 — the convergence stop rule for the six-lens review: round probe,
 * round-2 downgrade pre-pass, CONVERGED verdict, dedupe by severity, the
 * report_finding trigger, lensPassed, and the edited AGENTS.md §1 sentence.
 * Pure-function coverage; the write path is covered by the ledger tests.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NO_TRIGGER_REASON,
  applyRoundDowngrade,
  convergeVerdict,
} from "../src/lens-review-converge.ts";
import { computeVerdict, dedupeFindings, extractFindings } from "../src/lens-review-format.ts";
import type { Finding, LensRunResult } from "../src/lens-review-types.ts";
import { roundAfter } from "../src/review-ledger-round.ts";
import { lensPassed } from "../src/review-ledger.ts";
import type { LedgerEntry } from "../src/review-ledger.ts";
import { severityFromQuote } from "../src/review-threshold.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const f = (over: Partial<Finding>): Finding => ({
  lens: "ARCHITECTURE",
  severity: "MEDIUM",
  path: "src/a.ts",
  line: 10,
  title: "thing",
  ...over,
});
const lens = (over: Partial<LensRunResult> = {}): LensRunResult => ({
  lens: "ARCHITECTURE",
  ok: true,
  ms: 1,
  startMs: 0,
  findings: [],
  attempts: 1,
  blocked: false,
  summary: "reviewed",
  ...over,
});
const okLenses = [lens()];

// ------------------------------------------------------------ round probe
{
  const e = (over: Partial<LedgerEntry>): LedgerEntry => ({
    branch: "b",
    kind: "lens",
    patchId: "p",
    passed: true,
    at: 1,
    ...over,
  });
  assert(roundAfter(undefined) === 1, "probe: no prior entry → round 1");
  assert(roundAfter(e({})) === 2, "probe: prior entry without round → round 2");
  assert(roundAfter(e({ round: 4 })) === 5, "probe: prior round N → N+1");
  assert(
    roundAfter(e({ round: 4, detail: "REVIEW_INCOMPLETE" })) === 4,
    "probe: prior REVIEW_INCOMPLETE round N → N (not advanced)",
  );
}

// ------------------------------------------------------- trigger extraction
{
  const base = { severity: "MEDIUM", path: "x.ts", title: "t" };
  const got = (args: Record<string, unknown>) =>
    extractFindings([{ name: "report_finding", arguments: { ...base, ...args } }], "L").findings[0]
      ?.trigger;
  assert(got({}) === undefined, "trigger: absent → no trigger");
  assert(got({ trigger: 42 }) === undefined, "trigger: non-string → no trigger");
  assert(got({ trigger: "   " }) === undefined, "trigger: whitespace-only → no trigger");
  assert(
    got({ trigger: " POST /x with empty body " }) === "POST /x with empty body",
    "trigger: kept, trimmed",
  );
}

// -------------------------------------------------- downgrade pre-pass rules
{
  const med = f({ title: "no trigger" });
  const trig = f({ title: "triggered", trigger: "send 2 requests" });
  const high = f({ severity: "HIGH", title: "high" });
  const crit = f({ severity: "CRITICAL", title: "crit" });
  assert(
    applyRoundDowngrade([med], 1, new Set([med]))[0]?.severity === "MEDIUM",
    "round 1: no pre-pass, MEDIUM stays",
  );
  const r2 = applyRoundDowngrade([med, trig, high, crit], 2, new Set([med, trig, high, crit]));
  assert(
    r2[0]?.severity === "LOW" && r2[0]?.downgrade?.reason === NO_TRIGGER_REASON,
    "round 2: trigger-less MEDIUM → LOW with reason 'no trigger'",
  );
  assert(
    r2[1]?.severity === "MEDIUM" && !r2[1]?.downgrade,
    "round 2: triggered MEDIUM not downgraded",
  );
  assert(
    r2[2]?.severity === "HIGH" && r2[3]?.severity === "CRITICAL",
    "HIGH and CRITICAL never downgraded",
  );
  assert(med.severity === "MEDIUM", "pre-pass does not mutate its input");
}

// ------------------------------------------------------ verdicts end to end
{
  const verdictOf = (findings: Finding[], round: number, lenses = okLenses) => {
    const judged = applyRoundDowngrade(findings, round, new Set(findings));
    return convergeVerdict(computeVerdict(dedupeFindings(judged, []), lenses), judged);
  };
  assert(verdictOf([f({})], 1) === "ISSUES_FOUND", "round 1 trigger-less MEDIUM → ISSUES_FOUND");
  assert(verdictOf([f({})], 2) === "CONVERGED", "round 2 trigger-less MEDIUMs only → CONVERGED");
  assert(
    verdictOf([f({ trigger: "x" })], 2) === "ISSUES_FOUND",
    "round 2 triggered MEDIUM → ISSUES_FOUND",
  );
  assert(verdictOf([f({ severity: "HIGH" })], 2) === "ISSUES_FOUND", "round 2 HIGH → ISSUES_FOUND");
  assert(
    verdictOf([f({ severity: "CRITICAL" })], 2) === "CRITICAL_ISSUES_FOUND",
    "round 2 CRITICAL → CRITICAL_ISSUES_FOUND",
  );
  assert(verdictOf([], 2) === "APPROVED", "zero findings → APPROVED (round 2)");
  assert(verdictOf([], 1) === "APPROVED", "zero findings → APPROVED (round 1)");
  assert(
    verdictOf([f({})], 2, [lens({ blocked: true, ok: false })]) === "REVIEW_INCOMPLETE",
    "a blocked lens keeps REVIEW_INCOMPLETE over CONVERGED",
  );
  assert(
    verdictOf([f({})], 2, [lens({ findings: [], summary: undefined, ok: true })]) ===
      "REVIEW_INCOMPLETE",
    "a silent lens keeps REVIEW_INCOMPLETE over CONVERGED",
  );
  // Dedupe: the triggered MEDIUM outranks the downgraded duplicate.
  const dup = [f({ title: "same", trigger: "boom" }), f({ title: "Same", lens: "SECURITY" })];
  const kept = dedupeFindings(applyRoundDowngrade(dup, 2, new Set(dup)), []);
  assert(
    kept.length === 1 && kept[0]?.severity === "MEDIUM" && kept[0]?.trigger === "boom",
    "dedupe keeps the triggered MEDIUM over a downgraded duplicate",
  );
  assert(verdictOf(dup, 2) === "ISSUES_FOUND", "the verdict reflects the kept triggered record");
  // Equal severity, trigger-less duplicate seen FIRST: the triggered one still wins (dedupe runs before the downgrade).
  const dupFirst = dedupeFindings(
    [f({ title: "same", lens: "SECURITY" }), f({ title: "Same", trigger: "boom" })],
    [],
  );
  assert(
    dupFirst.length === 1 && dupFirst[0]?.trigger === "boom",
    "dedupe at equal severity keeps the triggered duplicate over a trigger-less one",
  );
  // Threshold LOW: a surviving downgraded LOW blocks, so no CONVERGED pass.
  const lowSrc = f({});
  const judgedLow = applyRoundDowngrade([lowSrc], 2, new Set([lowSrc]));
  assert(
    computeVerdict(judgedLow, okLenses, "LOW") === "ISSUES_FOUND",
    "threshold LOW: a downgraded LOW is at the bar and blocks",
  );
}

// ------------------------------------------------------- lensPassed / verdicts
assert(
  lensPassed("CONVERGED", "MEDIUM") &&
    lensPassed("CONVERGED", "HIGH") &&
    lensPassed("CONVERGED", "LOW"),
  "lensPassed(CONVERGED) true at every threshold",
);
assert(!lensPassed("REVIEW_INCOMPLETE", "MEDIUM"), "lensPassed(REVIEW_INCOMPLETE) still false");

// ------------------------------------------------ doctrine sentence (§1)
{
  const agents = readFileSync(path.join(here, "..", "..", "AGENTS.md"), "utf8");
  const sentence =
    "**Six-pass review findings are blocking at MEDIUM severity and above** (from the second lens round, a MEDIUM blocks only when it names a concrete trigger).";
  assert(agents.includes(sentence), "AGENTS.md §1 carries the edited sentence");
  const quote =
    "Six-pass review findings are blocking at MEDIUM severity and above (from the second lens round, a MEDIUM blocks only when it names a concrete trigger).";
  assert(
    severityFromQuote(quote) === "MEDIUM",
    "the edited sentence still resolves the threshold to MEDIUM",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
