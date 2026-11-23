#!/usr/bin/env bun
/**
 * #1938 — a developer dispatched into a detached worktree is first put on a
 * per-tree named branch, so the reviews of that tree record a ledger row; and a
 * tool-path review that records no branch-keyed row is reported as failed.
 *
 * Real git, temp repos (lib/review-ledger-test-helpers.ts setupRepo), the REAL
 * ledger writer reading back the REAL ledger file. spawn.ts is stubbed so the
 * dispatch tool never starts a Pi child.
 */

import { mock } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const spawnedCwds: (string | undefined)[] = [];
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1938",
  spawnSpecialist: async (spec: { role: string; cwd?: string }) => {
    spawnedCwds.push(spec.cwd);
    const text = "VERDICT: APPROVED\n\nlooks good";
    return { role: spec.role, ok: true, text, toolUses: [], ms: 1, exitCode: 0 };
  },
}));

const { buildLedgerNote } = await import("../src/adversarial-ledger-note.ts");
const { registerAdversarialTool } = await import("../src/adversarial-tool.ts");
const { prepareDevelopTree } = await import("../src/develop-branch.ts");
const { registerDispatchTools } = await import("../src/dispatch.ts");
const { writeLensLedgerEntry } = await import("../src/lens-ledger.ts");
const { readLedgerFile } = await import("../src/review-ledger.ts");
const { claimCycle } = await import("../src/work-driver-registry.ts");
const { ledgerFile, setupRepo } = await import("./lib/review-ledger-test-helpers.ts");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The writer must land in the temp repo's own ledger, never an inherited override.
Reflect.deleteProperty(process.env, "PI_ENSEMBLE_REVIEW_LEDGER_FILE");

const { repo } = setupRepo();
const sh = (cmd: string, cwd = repo) =>
  execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const addTree = (name: string, ref = "feature/x") => {
  const abs = path.join(repo, ".worktrees", name);
  sh(`git worktree add -q --detach ${abs} ${ref}`);
  return abs;
};
const onBranch = (cwd: string) => {
  try {
    return sh("git symbolic-ref --short -q HEAD", cwd);
  } catch {
    return "";
  }
};
const rows = () => readLedgerFile(ledgerFile(repo)).entries;
const refusal = async (role: string, cwd: string) =>
  prepareDevelopTree(role, cwd).then(
    () => "",
    (err: Error) => err.message,
  );

interface Tool {
  name: string;
  execute: (id: string, raw: unknown) => Promise<{ content: { text: string }[] }>;
}
const tools: Tool[] = [];
const sent: string[] = [];
// biome-ignore lint/suspicious/noExplicitAny: testing seam — the minimum shape the tools need.
const pi: any = {
  registerTool: (t: Tool) => tools.push(t),
  sendUserMessage: (m: unknown) => sent.push(typeof m === "string" ? m : JSON.stringify(m)),
};
registerDispatchTools(pi as ExtensionAPI);
registerAdversarialTool(pi as ExtensionAPI);
const tool = (name: string) => tools.find((t) => t.name === name) as Tool;
/** The async report a tool call delivers (the calls here run one at a time). */
const reportOf = async (run: () => Promise<unknown>) => {
  const before = sent.length;
  await run();
  for (let i = 0; i < 400 && sent.length === before; i++)
    await new Promise((r) => setTimeout(r, 25));
  return sent.slice(before).join("\n");
};

try {
  // (1) Control: before any correction, a review of a detached tree records nothing.
  const a = addTree("issue-7-a");
  const b = addTree("issue-7-b");
  const control = await writeLensLedgerEntry("APPROVED", "HIGH", a);
  assert(control.recorded === false, "(1) control: a detached tree's review records no row");

  // (2) N=2 sharing one slug, one batch: each tree ends on its own branch, named
  // from the tree and not from a subdirectory cwd, and records its own row.
  const bSub = path.join(b, "sub");
  mkdirSync(bSub);
  const reply = await tool("dispatch_parallel").execute("t", {
    specs: [
      { role: "developer", prompt: "work", cwd: a },
      { role: "developer", prompt: "work", cwd: bSub },
    ],
  });
  const replyText = reply.content[0]?.text ?? "";
  assert(
    replyText.includes("now on branch wt/issue-7-a") &&
      replyText.includes("now on branch wt/issue-7-b"),
    "(2) the dispatch reply names the branch it chose for each tree",
  );
  await new Promise((r) => setTimeout(r, 100));
  assert(spawnedCwds.includes(a), "(2) the developers were still dispatched into their trees");
  assert(
    onBranch(a) === "wt/issue-7-a" && onBranch(b) === "wt/issue-7-b",
    `(2) the two trees are on distinct named branches (${onBranch(a)}, ${onBranch(b)})`,
  );
  for (const t of [a, b]) {
    sh(`git commit -q --allow-empty -m work-${path.basename(t)}`, t);
    const out = await writeLensLedgerEntry("APPROVED", "HIGH", t);
    assert(out.recorded === true, `(2) the review of ${path.basename(t)} reports recorded`);
  }
  const keyed = rows().map((r) => r.branch);
  assert(
    keyed.includes("wt/issue-7-a") && keyed.includes("wt/issue-7-b"),
    `(2) the ledger file holds a row for each branch (${JSON.stringify(keyed)})`,
  );

  // (3) A named-branch tree is unaffected.
  const named = path.join(repo, ".worktrees", "named");
  sh(`git worktree add -q -b feature/named ${named} feature/x`);
  assert((await refusal("developer", named)) === "", "(3) a named-branch tree is not refused");
  assert(onBranch(named) === "feature/named", "(3) and stays on its own branch");

  // (4) A branch holding commits HEAD lacks is never moved: the dispatch is refused.
  const c = addTree("issue-7-c", "dev");
  const tip = sh("git rev-parse feature/x");
  sh("git branch wt/issue-7-c feature/x");
  const refused = await tool("dispatch_specialist")
    .execute("t", { role: "developer", prompt: "work", cwd: c })
    .then(
      () => "",
      (err: Error) => err.message,
    );
  assert(
    /^Refused: .*wt\/issue-7-c already holds commits/.test(refused),
    `(4) refused, naming the branch and why (${refused.slice(0, 120)})`,
  );
  assert(!spawnedCwds.includes(c), "(4) no developer was dispatched into the refused tree");
  assert(onBranch(c) === "" && sh("git rev-parse wt/issue-7-c") === tip, "(4) nothing moved");

  // (5) A branch HEAD already contains is fast-forwarded, not refused.
  const d = addTree("issue-7-d");
  sh("git branch wt/issue-7-d dev");
  assert((await refusal("developer", d)) === "", "(5) an ancestor branch is fast-forwarded");
  assert(sh("git rev-parse wt/issue-7-d") === sh("git rev-parse HEAD", d), "(5) onto HEAD");

  // (6) The adversarial loop's fix developer gets the same treatment; a report-only
  // one does not, and its clean verdict on the detached tree is reported as failed.
  const e = addTree("issue-7-e");
  const f = addTree("issue-7-f");
  const diff = "diff --git a/f b/f\n+x";
  const eReport = await reportOf(() =>
    tool("adversarial_loop").execute("t", { context: "c", diff, workCwd: e }),
  );
  const fReport = await reportOf(() =>
    tool("adversarial_loop").execute("t", { context: "c", diff, workCwd: f, reportOnly: true }),
  );
  assert(onBranch(e) === "wt/issue-7-e", "(6) a fixing adversarial_loop corrects workCwd");
  assert(onBranch(f) === "", "(6) a report-only adversarial_loop leaves workCwd alone");
  assert(
    eReport.includes("Continue the workflow") && !eReport.includes("REVIEW NOT RECORDED"),
    `(6) control: the corrected tree's clean verdict passes (${eReport.slice(0, 160)})`,
  );
  assert(
    fReport.includes("REVIEW NOT RECORDED") && !fReport.includes("Continue the workflow"),
    `(6) the unrecorded tool-path verdict is a failed result (${fReport.slice(0, 160)})`,
  );

  // (6b) A fixing adversarial_loop never moves the tree of a live /work cycle.
  const live = addTree("issue-9-live");
  const claim = claimCycle(9, [9]);
  const liveRefusal = await tool("adversarial_loop")
    .execute("t", { context: "c", workCwd: live })
    .then(
      () => "",
      (err: Error) => err.message,
    );
  if (claim.ok) claim.claim.release();
  assert(/running \/work driver cycle for #9/.test(liveRefusal), "(6b) refused on a live tree");
  assert(onBranch(live) === "", "(6b) and the live tree's HEAD was not moved");

  // (7) Not a developer, the operator's own checkout, a non-repo: untouched.
  const g = addTree("issue-7-g");
  assert((await prepareDevelopTree("explore", g)) === undefined, "(7) explore is not gated");
  sh("git checkout -q --detach HEAD");
  assert((await refusal("developer", repo)) === "", "(7) the main checkout is not refused");
  assert(onBranch(g) === "" && onBranch(repo) === "", "(7) and neither tree was moved");
  const plain = mkdtempSync(path.join(os.tmpdir(), "develop-branch-plain-"));
  assert((await refusal("developer", plain)) === "", "(7) a non-repo cwd is left alone");
  rmSync(plain, { recursive: true, force: true });

  // (8) Without the tool flag (the driver/lean shape) an unrecorded review keeps its `ok`.
  const r = { role: "adversarial-loop", ok: true, text: "APPROVED", toolUses: [], ms: 1 };
  const driver8 = await buildLedgerNote({ workCwd: g });
  const named8 = await buildLedgerNote({ workCwd: named, failUnrecorded: true });
  assert(driver8.withLedgerNote(r).ok === true, "(8) without the tool flag `ok` is untouched");
  assert(named8.withLedgerNote(r) === r, "(8) a review that resolves a branch is untouched");
} finally {
  rmSync(path.dirname(repo), { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
