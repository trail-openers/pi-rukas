#!/usr/bin/env bun
/**
 * #1129 — the convergence rule's wiring: every lens-verdict branch handles
 * CONVERGED (grep), the report_finding tool's trigger handling, the residual
 * disclosure for CONVERGED with downgraded findings (STUBBED forge), and the
 * findings memory carrying a trigger across rounds (real temp git clone).
 * Pure-function coverage lives in test-lens-converge-1129.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRoundDowngrade, judgeRound } from "../src/lens-review-converge.ts";
import { extractFindings } from "../src/lens-review-format.ts";
import { postLensResidualDisclosure } from "../src/lens-review-residuals.ts";
import type { Finding, LensRunResult } from "../src/lens-review-types.ts";
import { LENS_REPORTER_PATH, type LensReviewSummary } from "../src/lens-review.ts";
import { evaluateRoundCapMerge } from "../src/merge-guard-round-cap.ts";
import { readBranchRows, recordFindingRunOutcome } from "../src/review-findings-store.ts";
import { lensPassed } from "../src/review-ledger.ts";
import { commandOf } from "./lib/argv-shell.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");

// ------------------------------------- every lens APPROVED branch handles CONVERGED
{
  const files = readdirSync(srcDir).filter((n) => n.endsWith(".ts"));
  let sites = 0;
  const unhandled: string[] = [];
  for (const name of files) {
    const lines = readFileSync(path.join(srcDir, name), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/\bverdict\s*[!=]==\s*"APPROVED"/.test(line)) return;
      sites++;
      const window = lines.slice(i, i + 3).join("\n");
      if (!window.includes("CONVERGED")) unhandled.push(`${name}:${i + 1}`);
    });
  }
  assert(sites >= 2, `grep: found ${sites} lens-verdict APPROVED branches (expected ≥ 2)`);
  assert(
    unhandled.length === 0,
    `grep: every verdict === "APPROVED" branch also handles CONVERGED${unhandled.length ? ` — missing: ${unhandled.join(", ")}` : ""}`,
  );
}

// ------------------------------------------------ report_finding trigger handling
{
  let tool: { execute: (id: string, args: unknown) => Promise<{ details: unknown }> } | undefined;
  // Loaded by path, as the lens child does (--extension LENS_REPORTER_PATH).
  const reporter = (await import(LENS_REPORTER_PATH)).default as (pi: unknown) => void;
  reporter({
    registerTool: (t: unknown) => {
      tool = t as typeof tool;
    },
  } as never);
  const base = { severity: "MEDIUM", path: "src/a.ts", line: 3, title: "t" };
  const variants: Array<[string, Record<string, unknown>]> = [
    ["absent", {}],
    ["non-string", { trigger: 42 }],
    ["whitespace-only", { trigger: "   " }],
  ];
  for (const [label, extra] of variants) {
    const args = { ...base, ...extra };
    const res = await tool?.execute("id", args);
    assert(res !== undefined, `reporter: report_finding executes with trigger ${label}`);
    const parsed = extractFindings([{ name: "report_finding", arguments: args }], "SIMPLICITY");
    assert(
      parsed.findings[0]?.trigger === undefined,
      `reporter: trigger ${label} is treated as no trigger`,
    );
  }
  const withTrigger = { ...base, trigger: " send two requests " };
  const res = await tool?.execute("id", withTrigger);
  const parsed = extractFindings(
    [{ name: "report_finding", arguments: withTrigger }],
    "SIMPLICITY",
  );
  assert(
    parsed.findings[0]?.trigger === "send two requests",
    "reporter: a concrete trigger is kept (trimmed)",
  );
  assert(
    (res?.details as { trigger?: unknown } | undefined)?.trigger === " send two requests ",
    "reporter: the tool result carries the trigger it was given",
  );
}

// ------------------------------------------------ residual disclosure for CONVERGED
{
  process.env.PI_ENSEMBLE_FORGE = "github";
  const dir = mkdtempSync(path.join(tmpdir(), "pi-converge-residuals-"));
  const calls: string[] = [];
  const bodies: string[] = [];
  const execFn = async (cmd0: string, o?: { argv?: string[] }): Promise<{ stdout: string }> => {
    const cmd = commandOf(cmd0, o);
    calls.push(cmd);
    // The body is written to a temp file (`--body-file`) that is removed after
    // the post, so read it here while it exists.
    const file = cmd.match(/--body-file\s+'?([^'\s]+)'?/)?.[1];
    if (cmd.includes("pr comment") && file) bodies.push(readFileSync(file, "utf8"));
    if (cmd.includes("pr list --state open --head feature/x")) {
      return { stdout: JSON.stringify([{ number: 12 }]) };
    }
    if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
      return {
        stdout: JSON.stringify({
          headRefName: "feature/x",
          baseRefName: "main",
        }),
      };
    }
    if (cmd.includes("git config --get remote.origin.url")) {
      return { stdout: "git@github.com:o/r.git\n" };
    }
    if (cmd.includes("git config --get remote.upstream.url")) {
      return { stdout: "git@github.com:o/r.git\n" };
    }
    if (cmd.includes("git remote")) return { stdout: "origin\n" };
    if (cmd.includes("git fetch")) return { stdout: "" };
    if (cmd.includes("patch-id")) return { stdout: "p42 0000" };
    if (cmd.includes("pr comment")) return { stdout: "" };
    throw new Error(`unexpected exec: ${cmd}`);
  };
  try {
    const downgraded: Finding = {
      lens: "SIMPLICITY",
      severity: "LOW",
      path: "src/a.ts",
      line: 3,
      title: "no trigger finding",
      downgrade: { from: "MEDIUM", reason: "no trigger" },
    };
    const summary = {
      verdict: "CONVERGED",
      totalFindings: 1,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1 },
      lenses: [],
      findings: [downgraded],
    } as unknown as LensReviewSummary;
    const note = await postLensResidualDisclosure({
      summary,
      branch: "feature/x",
      cwd: dir,
      execFn,
    });
    assert(
      note === "",
      "residuals: CONVERGED with downgraded findings posts without a failure note",
    );
    assert(
      calls.some((c) => c.includes("pr comment")),
      "residuals: CONVERGED posts the disclosure comment",
    );
    assert(
      bodies.some((b) => b.includes("no trigger")),
      "residuals: the disclosure names the downgrade reason 'no trigger'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------ CONVERGED merge-guard acceptance
{
  // The guard's strict rule reads the ledger's `passed` flag, which the writer
  // sets from lensPassed(verdict). A passed CONVERGED entry is therefore not
  // refused: the round-cap path does not apply to it either.
  assert(
    lensPassed("CONVERGED", "MEDIUM"),
    "merge guard: a CONVERGED entry is written passed=true",
  );
  const decision = evaluateRoundCapMerge(
    [
      {
        branch: "feature/x",
        kind: "lens",
        patchId: "p",
        passed: true,
        at: 1,
        detail: "CONVERGED",
      },
    ],
    "feature/x",
    "p",
    [],
    "0".repeat(40),
  );
  assert(
    decision.applies === false,
    "merge guard: a passed CONVERGED entry is not a round-cap refusal",
  );
}

// ------------------------------------ findings memory: downgrade, carry, trigger
{
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(path.join(tmpdir(), "findings-converge-"));
  try {
    git(dir, "init", "-q", "-b", "feat/x");
    git(dir, "config", "user.email", "dev@example.com");
    git(dir, "config", "user.name", "dev");
    mkdirSync(path.join(dir, "src"));
    writeFileSync(
      path.join(dir, "src", "a.ts"),
      ["export function alpha(x: number) {", "  const a = x + 1;", "  return a * 2;", "}"].join(
        "\n",
      ),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "c");
    const headSha = git(dir, "rev-parse", "HEAD");
    const lens: LensRunResult[] = [
      {
        lens: "SIMPLICITY",
        ok: true,
        ms: 1,
        startMs: 0,
        findings: [],
        attempts: 1,
        blocked: false,
        summary: "reviewed",
      },
    ];
    const base: Finding = {
      lens: "SIMPLICITY",
      severity: "MEDIUM",
      path: "src/a.ts",
      line: 2,
      title: "untriggered medium",
    };
    const run = (findings: Finding[], complete = true) =>
      recordFindingRunOutcome({
        cwd: dir,
        branch: "feat/x",
        headSha,
        findings,
        complete,
      });

    // Round 1: the trigger-less MEDIUM is recorded as MEDIUM (no pre-pass).
    await run(applyRoundDowngrade([base], 1));
    const r1 = await run([], true);
    const carried1 = r1.ok ? r1.carried : [];
    assert(
      carried1.length === 1 && carried1[0]?.severity === "MEDIUM",
      "memory: round 1 row carried as MEDIUM",
    );
    const j1 = judgeRound([], r1, [], lens, "MEDIUM", 2);
    assert(j1.verdict === "CONVERGED", "memory: a round-2 omitted trigger-less MEDIUM converges");
    assert(j1.reported[0]?.severity === "LOW", "memory: the carried finding is reported at LOW");
    assert(
      j1.reported[0]?.downgrade?.reason === "no trigger",
      "memory: the carried downgrade carries reason 'no trigger'",
    );

    // A downgraded fresh finding is stored at LOW.
    const stored = await readBranchRows(dir, "feat/x");
    assert(
      stored.length === 1 && stored[0]?.severity === "MEDIUM",
      "memory: round 1 stored MEDIUM",
    );
    await run(applyRoundDowngrade([{ ...base, title: "round two new" }], 2));
    const after = await readBranchRows(dir, "feat/x");
    const fresh = after.find((r) => r.title === "round two new");
    assert(fresh?.severity === "LOW", "memory: a downgraded fresh finding is stored at LOW");

    // A triggered MEDIUM carried across rounds keeps blocking.
    const trig: Finding = {
      ...base,
      title: "triggered medium",
      line: 3,
      trigger: "two calls",
    };
    await run([trig]);
    const r3 = await run([], true);
    const carriedTrig = r3.ok ? r3.carried.find((f) => f.title === "triggered medium") : undefined;
    assert(carriedTrig?.trigger === "two calls", "memory: the carried row keeps its trigger");
    const j3 = judgeRound([], r3, [], lens, "MEDIUM", 2);
    assert(
      j3.verdict === "ISSUES_FOUND",
      "memory: a triggered carried MEDIUM blocks (ISSUES_FOUND)",
    );
    assert(
      j3.reported.some((f) => f.title === "triggered medium" && f.severity === "MEDIUM"),
      "memory: a triggered carried MEDIUM stays MEDIUM",
    );

    // A row first seen trigger-less at round 2 is stored at LOW; when the lens
    // re-reports it WITH a trigger, the stored severity follows the latest
    // judgement, so a later carried copy still blocks instead of staying LOW.
    await run(applyRoundDowngrade([{ ...base, line: 1, title: "escalated" }], 2));
    await run([{ ...base, line: 1, title: "escalated", trigger: "two calls" }]);
    const r4 = await run([], true);
    const carriedEsc = r4.ok ? r4.carried.find((f) => f.title === "escalated") : undefined;
    assert(
      carriedEsc?.severity === "MEDIUM" && carriedEsc.trigger === "two calls",
      "memory: a re-reported triggered MEDIUM is stored at MEDIUM (not left at LOW)",
    );
    const j4 = judgeRound([], r4, [], lens, "MEDIUM", 3);
    assert(
      j4.verdict === "ISSUES_FOUND",
      "memory: a carried escalated MEDIUM blocks at round 3 (ISSUES_FOUND)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
