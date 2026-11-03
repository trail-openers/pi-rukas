#!/usr/bin/env bun
/**
 * The `dispatch_lens_review` tool path must apply the PROJECT's blocking bar.
 *
 * `resolveReviewThreshold` was wired into one caller only — the `/work` driver's
 * lens step — so every hand-run review judged findings at
 * `DEFAULT_REVIEW_THRESHOLD` (MEDIUM) whatever the project's doctrine said. In
 * this repo, whose §1 blocks at HIGH and above, that meant a round whose only
 * findings were MEDIUM came back ISSUES_FOUND: the ledger row recorded
 * `passed: false` and the merge guard refused, while the project's own sentence
 * stayed decorative on the path a person actually runs.
 *
 * The cases drive the REGISTERED tool — `execute`, then the async job body it
 * opened — so the assertion is on the verdict and the ledger row the tool
 * delivers, not on a value handed to a seam below it. Two replacements make the
 * round drivable offline: `spawnSpecialist` answers the doctrine question with
 * the project's HIGH sentence, and `runLensChild` reports the MEDIUM-only finding
 * set. Both are the seams the production path itself calls, so the tool's own
 * code still runs unmodified between them.
 *
 * The judge's quote is only honoured when the documents handed to it contain it:
 * `askPolicy` verifies the citation character by character. A fixture cannot
 * assert a bar the doctrine at the base commit does not state, which is what
 * makes the HIGH verdict evidence of the read rather than of the stub.
 */

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import { resolveHeadSha } from "../src/review-head-sha.ts";
import { identityBase } from "../src/review-ledger-path.ts";
import {
  readDoctrineDocsAtBase,
  resolveLensReviewThreshold,
} from "../src/review-threshold-at-base.ts";
import { withEnv } from "./lib/env-scope.ts";
import { realExec } from "./lib/exec-fake.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "lens-tool-threshold-"));
// The clone's origin: a bare repo with `main`, so the ledger writer can resolve a
// mainline and a patch id (without one the round records nothing and the row
// assertion below would vacuously pass).
const origin = path.join(root, "remote.git");
const repo = path.join(root, "repo");
const ledgerFile = path.join(root, "review-ledger.json");
const skills = path.join(root, "skills");

/** The sentence §1's shape gives the bar; the doctrine below states it. */
const HIGH_QUOTE = "Six-pass review findings are blocking at HIGH severity and above.";

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: gitTestEnv(),
  }).trim();

mkdirSync(repo, { recursive: true });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
// Committed at the BASE, not merely left on disk: the whole rule under test is
// that doctrine is read AT a commit, so a working-tree copy proves nothing.
writeFileSync(
  path.join(repo, "AGENTS.md"),
  `# Contributing\n\n## 1. Gates\n\n**${HIGH_QUOTE}**\nMEDIUM and LOW findings are disclosed on the PR and may be deferred.\n`,
);
writeFileSync(path.join(repo, "src-a.ts"), "export const a = 1;\n");
git("add", "-A");
git("commit", "-q", "-m", "base");
const baseSha = git("rev-parse", "HEAD");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitTestEnv() });
git("remote", "add", "origin", origin);
git("push", "-q", "origin", "main");
git("fetch", "-q", "origin");
git("remote", "set-head", "origin", "main");
git("checkout", "-q", "-b", "feature/x");
writeFileSync(path.join(repo, "src-a.ts"), "export const a = 1;\nexport const b = 2;\n");
git("add", "-A");
git("commit", "-q", "-m", "feature");
const headSha = git("rev-parse", "HEAD");

mkdirSync(skills, { recursive: true });
let prec = 10;
for (const l of LENS_ROSTER) {
  mkdirSync(path.join(skills, l.skill), { recursive: true });
  writeFileSync(
    path.join(skills, l.skill, "SKILL.md"),
    `---\nname: ${l.skill}\nprecedence: ${prec}\n---\n`,
  );
  prec += 10;
}
process.env.PI_ENSEMBLE_SKILLS_DIR = skills;

// ── The two seams, installed BEFORE the modules under test are imported ──────
// The doctrine judge: answers with the HIGH sentence only when the prompt (which
// carries the documents the caller read) actually contains it, so the citation
// check upstream decides rather than the fixture.
const judgePrompts: string[] = [];
/** The doctrine documents, read from the base commit through the SAME executor
 * production uses (`realExec`, argv form honoured — a shell-only fake here would
 * turn `git show` into a bare `git` and the round would silently see no
 * doctrine). */
const readDoctrine = (baseRef: string | undefined) =>
  readDoctrineDocsAtBase(realExec, repo, baseRef);
/** The tool path's doctrine ref, computed by the same two resolvers the tool
 * uses (`identityBase` → the remote mainline tip, then its SHA). Case (4) needs
 * the ref the tool WILL read at, to set against the ref the caller named. */
const thresholdBaseRefForTest = async (cwd: string): Promise<string | undefined> => {
  const base = await identityBase(realExec, cwd);
  if (!base.ok) return undefined;
  return await resolveHeadSha(cwd, `${base.remote}/${base.mainline}`, realExec);
};
/** One judge, shared by the spawn seam below and by the resolver case: the tool
 * path builds `judgePolicy` itself, so the child is the only seam it has. */
const judgeAnswer = (prompt: string) => ({
  ok: true,
  toolUses: [
    {
      name: "report_policy",
      arguments: prompt.includes(HIGH_QUOTE)
        ? { verdict: "permitted", quote: HIGH_QUOTE, sourceFile: "AGENTS.md" }
        : { verdict: "unstated" },
    },
  ],
});
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "test-run",
  spawnSpecialist: async (spec: { prompt?: string }) => {
    judgePrompts.push(spec.prompt ?? "");
    return {
      ok: true,
      toolUses: [
        {
          name: "report_policy",
          arguments: (spec.prompt ?? "").includes(HIGH_QUOTE)
            ? { verdict: "permitted", quote: HIGH_QUOTE, sourceFile: "AGENTS.md" }
            : { verdict: "unstated" },
        },
      ],
    };
  },
}));

/** The MEDIUM-only finding set the defect turns on: disclosable under a HIGH bar,
 * blocking at the MEDIUM default. */
const MEDIUM_ONLY = [
  { severity: "MEDIUM", path: "src-a.ts", line: 2, title: "Unclear module contract" },
];
/** Whether the stub lens reports the MEDIUM finding. */
const reportMedium = true;
mock.module(new URL("../src/lens-review-child.ts", import.meta.url).href, () => ({
  runLensChild: async (args: { lens: { name: string } }): Promise<LensRunResult> =>
    ({
      lens: args.lens.name,
      ok: true,
      ms: 1,
      startMs: Date.now(),
      attempts: 1,
      blocked: false,
      summary: "reviewed the diff",
      findings:
        reportMedium && args.lens.name === LENS_ROSTER[0]?.name
          ? MEDIUM_ONLY.map((f) => ({ lens: args.lens.name, ...f }))
          : [],
    }) as unknown as LensRunResult,
}));

const { registerLensReviewTool } = await import("../src/lens-review-tool.ts");
const { runLensReview } = await import("../src/lens-review.ts");

const sent: string[] = [];
const tools = new Map<string, { execute: (id: string, raw: unknown) => Promise<unknown> }>();
registerLensReviewTool({
  registerTool: (t: { name?: string }) => tools.set(String(t.name), t as never),
  sendUserMessage: (msg: unknown) => sent.push(typeof msg === "string" ? msg : JSON.stringify(msg)),
} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

async function waitFor(pred: () => boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  if (!pred()) throw new Error("timed out waiting for the async lens review to settle");
}

const ledgerRows = (): Record<string, unknown>[] => {
  try {
    return JSON.parse(readFileSync(ledgerFile, "utf8")).entries as Record<string, unknown>[];
  } catch {
    return [];
  }
};

await withEnv(
  { PI_ENSEMBLE_REVIEW_LEDGER_FILE: ledgerFile, PI_ENSEMBLE_SKILLS_DIR: skills },
  async () => {
    try {
      // ── (1) CONTROL at the review layer: the same findings, no threshold, block.
      // Without it, the approval below could be the fixture reporting nothing.
      {
        const control = await runLensReview({
          diff: "diff --git a/src-a.ts b/src-a.ts\n+export const b = 2;",
          cwd: repo,
          branch: "feature/x",
          head: headSha,
          full: true,
        });
        assert(
          control.verdict === "ISSUES_FOUND",
          `(1) control: the MEDIUM-only set blocks at the review layer's default (${control.verdict})`,
        );
      }

      // ── (2) THE TOOL PATH, end to end: one MEDIUM finding, a doctrine that blocks
      // at HIGH, and the bar the tool resolved is therefore HIGH.
      {
        const tool = tools.get("dispatch_lens_review");
        assert(tool !== undefined, "(2) the lens review tool is registered");
        const before = sent.length;
        if (!tool) throw new Error("the lens review tool did not register");
        const handle = (await tool.execute("t1", {
          cwd: repo,
          diff: "diff --git a/src-a.ts b/src-a.ts\n+export const b = 2;",
          branch: "feature/x",
          head: headSha,
          full: true,
        })) as { content?: { text?: string }[] };
        assert(
          (handle.content?.[0]?.text ?? "").includes("Dispatched async lens review"),
          "(2) the tool returned a job handle and the review runs in the job",
        );
        await waitFor(() => sent.length > before);
        const report = sent.slice(before).join("\n");
        assert(
          judgePrompts.length > 0,
          "(2) the tool asked the doctrine a question — a path that never asks cannot honour the project's bar",
        );
        assert(
          judgePrompts[judgePrompts.length - 1]?.includes(HIGH_QUOTE) === true,
          "(2) and the question carried the doctrine read at the base commit: a bar with no documents behind it is an invention, not a citation",
        );
        assert(
          /^Code review verdict \(\d+ lenses\): APPROVED/m.test(report),
          `(2) A MEDIUM-ONLY ROUND UNDER THE PROJECT'S HIGH BAR APPROVES ON THE TOOL PATH — at the MEDIUM default the same round is ISSUES_FOUND, the ledger says the review failed, and the merge guard refuses (report: ${report.slice(0, 220).replace(/\n/g, " ")})`,
        );
        const row = ledgerRows()
          .filter((e) => e.kind === "lens")
          .pop();
        assert(
          row?.passed === true,
          `(2) and the LEDGER AGREES with the verdict: passed=true. A verdict computed at the project's bar while the row is scored at the default is the split that makes the guard refuse a review that passed (got ${String(row?.passed)}, detail ${String(row?.detail)})`,
        );
      }

      // ── (3) THE FINDING IS REAL: the same round, with the project's bar NOT read
      // (no base ref, so no doctrine, so the shipped default), comes back
      // ISSUES_FOUND on the very same stub. This is the assertion that makes (2) a
      // measurement rather than a description: one variable — whether the doctrine
      // was read — flips APPROVED to ISSUES_FOUND, so the approval is attributable
      // to the bar and not to the fixture reporting nothing.
      {
        const before = judgePrompts.length;
        const noDoctrine = await resolveLensReviewThreshold({
          judge: async (prompt: string) => {
            judgePrompts.push(prompt);
            return judgeAnswer(prompt);
          },
          execFn: realExec,
          repoRoot: repo,
          // No base ref: nothing to read, which is the ordinary case for a repo with
          // no doctrine, and must land on the default rather than an error.
          baseRef: undefined,
        });
        assert(
          noDoctrine === "MEDIUM",
          `(3) with no doctrine to read the bar is the shipped default, and no judge was paid (got ${noDoctrine}; judge calls ${String(judgePrompts.length - before)})`,
        );
        const atDefault = await runLensReview({
          diff: "diff --git a/src-a.ts b/src-a.ts\n+export const b = 2;",
          cwd: repo,
          branch: "feature/x",
          head: headSha,
          full: true,
          threshold: "MEDIUM",
        });
        assert(
          atDefault.verdict === "ISSUES_FOUND",
          `(3) the same stub findings at the DEFAULT bar are ISSUES_FOUND — the difference between this and (2) is only the bar the doctrine supplied (${atDefault.verdict})`,
        );
      }

      // ── (4) THE BAR IS NOT THE CALLER'S TO CHOOSE. `base` and `head` are model
      // input, so a tool that read doctrine at either let the reviewed branch pick
      // the severity it is judged against. This round is a SAME-ROUND comparison:
      // one MEDIUM finding (which the project's HIGH bar discloses and the shipped
      // MEDIUM default blocks) plus a judge that answers HIGH only for the MAINLINE
      // doctrine's sentence and CRITICAL for the branch's. So exactly one variable
      // — which ref the doctrine was read at — decides the verdict: reading the
      // mainline tip gives HIGH and the finding is disclosable (APPROVED, and the
      // ledger row passes); reading the ref the caller named gives CRITICAL and the
      // same finding blocks. A fixture cannot pick its way to the green answer:
      // each arm makes the other arm's verdict the failure.
      {
        // The branch's own commit states a laxer bar, and the judge below quotes it
        // verbatim — so a review that read THAT file really would see CRITICAL.
        const LAX_QUOTE = "Only CRITICAL findings block the merge.";
        writeFileSync(
          path.join(repo, "AGENTS.md"),
          `# Contributing\n\n## 1. Gates\n\n**${LAX_QUOTE}**\n`,
        );
        git("add", "AGENTS.md");
        git("commit", "-q", "-m", "the branch loosens its own bar");
        const laxHead = git("rev-parse", "HEAD");
        git("checkout", "-q", "HEAD~1", "--", "AGENTS.md");
        // Both documents exist and state different bars, so the judge's answer is
        // determined by which ref was read and by nothing else.
        const [laxDocs, mainDocs] = await Promise.all([
          readDoctrine(laxHead),
          readDoctrine(baseSha),
        ]);
        assert(
          laxDocs.some((d) => d.text.includes(LAX_QUOTE)) &&
            mainDocs.some((d) => d.text.includes(HIGH_QUOTE)),
          `(4) the two doctrines genuinely differ — the caller's ref says only CRITICAL blocks, the mainline's says HIGH (${JSON.stringify([laxDocs, mainDocs].map((d) => d.map((x) => x.file)))})`,
        );
        // The judge quotes whichever sentence the documents it was handed contain.
        const judgeBoth = async (prompt: string) => {
          judgePrompts.push(prompt);
          const quote = prompt.includes(LAX_QUOTE)
            ? LAX_QUOTE
            : prompt.includes(HIGH_QUOTE)
              ? HIGH_QUOTE
              : undefined;
          return {
            ok: true,
            toolUses: [
              {
                name: "report_policy",
                arguments: quote
                  ? { verdict: "permitted", quote, sourceFile: "AGENTS.md" }
                  : { verdict: "unstated" },
              },
            ],
          };
        };
        const atMainline = await resolveLensReviewThreshold({
          judge: judgeBoth,
          execFn: realExec,
          repoRoot: repo,
          baseRef: await thresholdBaseRefForTest(repo),
        });
        const atCallerRef = await resolveLensReviewThreshold({
          judge: judgeBoth,
          execFn: realExec,
          repoRoot: repo,
          baseRef: laxHead,
        });
        assert(
          atMainline === "HIGH" && atCallerRef === "CRITICAL",
          `(4) ONE VARIABLE FLIPS THE BAR: read at the mainline tip the round is judged HIGH; read at the ref the caller named it is judged CRITICAL — the bar the branch chose (mainline=${atMainline}, caller's ref=${atCallerRef})`,
        );
        // And the tool path takes the mainline one: a MEDIUM-only round approves and
        // its ledger row passes, which is what the HIGH bar alone produces. The
        // attack's shape: the caller hands its own lax commit as BOTH ends of the
        // range and asks for the whole of it.
        const before = sent.length;
        const tool = tools.get("dispatch_lens_review");
        if (!tool) throw new Error("the lens review tool did not register");
        const handle = (await tool.execute("t-lax", {
          cwd: repo,
          diff: "diff --git a/src-a.ts b/src-a.ts\n+export const b = 2;",
          branch: "feature/x",
          base: laxHead,
          head: laxHead,
          full: true,
        })) as { content?: { text?: string }[] };
        assert(
          (handle.content?.[0]?.text ?? "").includes("Dispatched async lens review"),
          "(4) the round ran through the registered tool, not a seam below it",
        );
        await waitFor(() => sent.length > before);
        const report = sent.slice(before).join("\n");
        assert(
          /^Code review verdict \(\d+ lenses\): APPROVED/m.test(report),
          `(4) THE TOOL PATH JUDGES AT THE MAINLINE, NOT AT THE REF THE CALLER NAMED: its MEDIUM-only round discloses rather than blocks. At the bar in the caller's own commit the same round is ISSUES_FOUND (${report.slice(0, 240).replace(/\n/g, " ")})`,
        );
        const row = ledgerRows()
          .filter((e) => e.kind === "lens")
          .pop();
        assert(
          row?.passed === true,
          `(4) and the LEDGER AGREES: passed=true against the mainline's HIGH bar (got ${String(row?.passed)}, detail ${String(row?.detail)})`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

console.log(`\nexit ${exit}`);
process.exit(exit);
