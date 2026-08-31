#!/usr/bin/env bun
/**
 * PM's bash allowlist is the trust boundary's actual boundary: in trust mode
 * (the interactive default) the legacy hook returns before verdict resolution,
 * so the agents.json allowlist is decorative and PM improvises — running
 * `git commit` / `gh pr create` inline instead of dispatching to ops
 * (research 2026-08-31). The fix is the mode-independent `tool_call` hook in
 * pm-bash-guard.ts, registered in registerPermissionGuard ahead of the
 * subagent branch and the trust-mode early return.
 *
 * The hook enforces the REAL agents.json PM bash block (single source of
 * truth — no second copy that could drift), fires only while PM mode is
 * armed (isPmModeActive — subagents never arm it), fires in ALL modes
 * (trust, strict, headless, sandbox — the hook itself has no bypass), and
 * blocks everything else with a refusal that names the route.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { matchBashSubcommand, createsGitHubIssue } = await import("../src/bash-command-parser.ts");
const { loadAgentsJson, resolveAgentsJsonPath } = await import("../src/permission-config.ts");
const { armPmMode, resetPmMode } = await import("../src/pm-mode.ts");
const { registerPmBashGuard } = await import("../src/pm-bash-guard.ts");
const { registerPermissionGuard } = await import("../src/permission-guard.ts");

// The guard's own verdict logic: the agents.json PM bash block, matched via
// matchBashSubcommand exactly as the hook does. Only "allow" passes; anything
// else (no match, the "ask" catch-all, "deny", or the null that injection
// vectors produce) is a block.
function pmVerdict(command: string): string | null {
  const pmBash = (
    loadAgentsJson()["project-manager"]?.permission?.bash ??
    {}
  ) as Record<string, string>;
  return matchBashSubcommand(command, pmBash);
}

// --------------------------------------------------- the allowlist passes

for (const cmd of [
  // Read-only git (bare).
  "git status",
  "git status --porcelain",
  "git branch --show-current",
  "git log --oneline -10",
  "git diff HEAD",
  "git ls-files",
  // oo-wrapped reads (the wrapper is part of the pattern — matchBashSubcommand
  // matches on the raw command, so the allowlist carries BOTH shapes).
  "oo git log --oneline",
  "oo git diff HEAD",
  "oo git show 4b8",
  // gh reads.
  "gh issue list --limit 15",
  "gh issue view 600",
  "gh pr list --limit 10",
  "gh run list",
  // Memory + text utilities.
  "vipune search 'pm bash guard'",
  "vipune add 'finding' --memory-type fact",
  "echo hi",
  "wc -l file.txt",
  "jq .number issue.json",
  // Quoted operators are NOT injection (issue #108): stripQuotedSegments
  // removes the segment before the injection check.
  'echo "gh pr create && git push"',
  // `echo` / `find` only print / list — they do NOT execute or reach into the
  // tokens that follow, so a forbidden verb appearing in their ARGUMENTS is
  // not a bypass (`echo FOO=bar gh pr create` just prints that text, and
  // `find . -delete` is PM's own file-search allowlist, kept for low risk).
  "echo FOO=bar gh pr create --title x",
  "find . -delete",
]) {
  assert(pmVerdict(cmd) === "allow", `allowed — ${cmd}`);
}

// ------------------------------------------------------- everything else blocks

for (const cmd of [
  // Mutations the incident actually ran.
  "git commit -m 'fix: x'",
  "git push origin main",
  "oo git push origin x",
  "gh pr create --title x",
  "gh pr merge 123",
  "gh pr close 123",
  // Creative bypasses — interpreters, in-place editors, arbitrary HTTP, shells.
  "python -c 'print(1)'",
  "node -e 'console.log(1)'",
  "perl -e 'print 1'",
  "sed -i s/a/b/ file.txt",
  "curl -X POST https://example.com",
  "bash -c 'git commit -m x'",
  "sh -c 'rm -rf x'",
  // Wrappers around a forbidden inner command.
  "nohup git push",
  "timeout 30 git push",
  "FOO=bar git push origin x",
  // Wrapper-prefixed inner commands that must NOT piggy-back on a loose
  // allowlist row. `export FOO=x <mutation>` is a REAL bash bypass: bash sets
  // FOO then runs the inner command, so a `export …*` row would grant a
  // forbidden inner command. The `export PROJECT_ID=*` row is gone from
  // agents.json (PM sets env via dispatch prompts, not bash); these vectors
  // pin that removal.
  "export PROJECT_ID=123 git push origin main",
  "export X=y gh pr create --title test",
  // Injection chains hard-deny: matchBashSubcommand returns null for
  // unquoted injection chars, and null is not "allow".
  "git status; git push",
  "git status && git push origin x",
  "git log | grep x",
  "git status > out.txt",
  "git status `id`",
  "git status $(id)",
  // Not on the list at all.
  "rm -rf /",
  "ls",
]) {
  assert(pmVerdict(cmd) !== "allow", `blocked — ${cmd}`);
}

// injection vectors: null specifically (the spec's hard-denial surface)
for (const cmd of ["git status && git push", "git log | wc -l", "git status; rm -rf /"]) {
  assert(
    pmVerdict(cmd) === null,
    `injection vector → matchBashSubcommand null (hard-deny surface) — ${cmd}`,
  );
}

// The issue-creation door composes: this guard allows `gh api*` broadly
// (as agents.json does), while the REST POST-to-issues door stays blocked by
// the issue-creation guard — the two guards stack, they do not replace each
// other. Assert the division of labor explicitly.
assert(
  pmVerdict("gh api repos/o/r/issues -f title=x") === "allow",
  "this guard allows gh api broadly (the issue guard owns the POST-to-issues door)",
);
assert(
  createsGitHubIssue("gh api repos/o/r/issues -f title=x") !== undefined,
  "the issue-creation guard still catches the REST POST-to-issues door",
);

// ------------------------------------------- the hook itself: PM-only, all modes

type Handler = (
  event: { toolName: string; input: unknown },
  ctx: { hasUI: boolean },
) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined;

function captureGuardHandlers() {
  const handlers: Handler[] = [];
  const fakePi = {
    on(event: string, handler: Handler) {
      if (event === "tool_call") handlers.push(handler);
    },
  } as unknown as Parameters<typeof registerPmBashGuard>[0];
  registerPmBashGuard(fakePi);
  return handlers;
}

// Compose all registered hooks (the full registerPermissionGuard pipeline in
// sandbox mode: the two mode-independent guards, the legacy handler absent).
const callAll = async (handlers: Handler[], command: string, hasUI: boolean) => {
  for (const h of handlers) {
    const r = await h({ toolName: "bash", input: { command } }, { hasUI });
    if (r) return r;
  }
  return undefined;
};

const prevSandbox = process.env.PI_ENSEMBLE_SANDBOX_MODE;
process.env.PI_ENSEMBLE_SANDBOX_MODE = "1"; // sandbox mode: legacy handler absent

// Not armed: silent for every command, even forbidden ones.
resetPmMode();
{
  const handlers: Handler[] = [];
  const fakePi = {
    on: (event: string, handler: Handler) => {
      if (event === "tool_call") handlers.push(handler);
    },
  } as unknown as Parameters<typeof registerPermissionGuard>[0];
  registerPermissionGuard(fakePi);
  assert(handlers.length === 2, "hook: issue-creation + PM bash handlers registered (both ahead of the sandbox short-circuit)");
  assert(
    (await callAll(handlers, "git commit -m x", true)) === undefined,
    "hook: silent when PM mode is not armed (subagent/parent-idle)",
  );
}

// Armed: blocks in every mode, passes in every mode, refusal names the route.
armPmMode();
{
  const handlers = captureGuardHandlers();
  for (const hasUI of [true, false]) {
    assert(
      (await callAll(handlers, "git status", hasUI)) === undefined,
      `hook: allowlisted command passes (hasUI=${hasUI})`,
    );
    assert(
      (await callAll(handlers, "git commit -m x", hasUI)) !== undefined,
      `hook: non-allowlisted command blocks (hasUI=${hasUI})`,
    );
  }
  const blocked = await callAll(handlers, "git commit -m x", true);
  assert(
    blocked?.reason.includes("dispatch_specialist") && blocked?.reason.includes("agents.json"),
    "hook: refusal reason is actionable (names the allowlist + the dispatch route)",
  );
  // Non-bash tools: untouched.
  const r = await handlers[0]({ toolName: "read", input: {} }, { hasUI: true });
  assert(r === undefined, "hook: non-bash tools are untouched");
}

// Escape hatch: PI_ENSEMBLE_PM_BASH_GUARD=0 → no handler at all.
{
  process.env.PI_ENSEMBLE_PM_BASH_GUARD = "0";
  const handlers = captureGuardHandlers();
  delete process.env.PI_ENSEMBLE_PM_BASH_GUARD;
  assert(handlers.length === 0, "escape hatch: PI_ENSEMBLE_PM_BASH_GUARD=0 registers nothing");
}

if (prevSandbox === undefined) delete process.env.PI_ENSEMBLE_SANDBOX_MODE;
else process.env.PI_ENSEMBLE_SANDBOX_MODE = prevSandbox;

// ------------------------------------------- parity: the guard IS agents.json

{
  const agentsPath = resolveAgentsJsonPath();
  assert(
    path.basename(agentsPath) === "agents.json",
    `parity: reads the real agents.json (${agentsPath})`,
  );
  const raw = JSON.parse(readFileSync(agentsPath, "utf8")) as {
    agent?: { "project-manager"?: { permission?: { bash?: Record<string, unknown> } } };
  };
  const bash = raw.agent?.["project-manager"]?.permission?.bash ?? {};
  assert(bash["*"] === "ask", "parity: PM bash catch-all is ask (the guard turns it into a block)");
  assert(bash["gh api*"] === "allow", "parity: gh api allowed broadly (spec)");
  assert(bash["gh issue create*"] === "deny", "parity: gh issue create denied");
  // The `export PROJECT_ID=*` row used to let `export X=y git push` piggy-back
  // on a forbidden inner command. PM has no business exporting env in bash,
  // so the row is gone — the guard now blocks the wrapper-prefixed mutation.
  assert(
    bash["export PROJECT_ID=*"] === undefined,
    "parity: the dangerous `export PROJECT_ID=*` allowlist row is removed",
  );
  // Every allowlisted pattern must actually resolve to allow for a
  // representative command through the guard's own matcher.
  const samples: Array<[string, string]> = [
    ["git status*", "git status --porcelain"],
    ["oo git log *", "oo git log --oneline"],
    ["gh pr view*", "gh pr view 42"],
    ["vipune search *", "vipune search 'x'"],
    ["which*", "which bun"],
    ["jq*", "jq .a b.json"],
  ];
  for (const [pattern, cmd] of samples) {
    assert(bash[pattern] === "allow", `parity: pattern present — ${pattern}`);
    assert(pmVerdict(cmd) === "allow", `parity: guard matches the pattern — ${cmd}`);
  }
}

// ------------------------------------------- source-ordering canaries

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const pg = readFileSync(path.join(SRC, "permission-guard.ts"), "utf8");
  const ig = readFileSync(path.join(SRC, "pm-bash-guard.ts"), "utf8");
  const sub = readFileSync(path.join(SRC, "permission-subagent-guard.ts"), "utf8");

  // Parent guard: registered ahead of the subagent branch and the trust-mode
  // early return in the main handler.
  const guardIdx = pg.indexOf("registerPmBashGuard(pi)");
  const subagentIdx = pg.indexOf('PI_ENSEMBLE_SUBAGENT_MODE === "1"');
  const trustIdx = pg.indexOf("isInTrustMode(ctx.hasUI === true)");
  assert(guardIdx > 0, "canary: parent guard registers the PM bash guard");
  assert(
    guardIdx < subagentIdx && guardIdx < trustIdx,
    `it is registered BEFORE the subagent branch (=${subagentIdx}) and the trust-mode return (=${trustIdx})`,
  );
  // PM-only: the guard source MUST test isPmModeActive (inverted role canary
  // vs test-issue-creation-guard.ts, which asserts the inverse).
  assert(
    /isPmModeActive\(\)/.test(ig),
    "canary: the guard is PM-only — it tests isPmModeActive in source",
  );
  // Mode-independent: no mode env vars inside the guard itself.
  assert(
    !/PI_ENSEMBLE_TRUST_MODE|PI_ENSEMBLE_SANDBOX_MODE|PI_ENSEMBLE_SUBAGENT_MODE|PI_ENSEMBLE_STRICT_PERMISSIONS/.test(
      ig,
    ),
    "the guard is mode-agnostic — it is the hook registered before the bypasses, not a branch inside them",
  );
  // Escape hatch.
  assert(
    /PI_ENSEMBLE_PM_BASH_GUARD === "0"/.test(ig),
    "escape hatch: PI_ENSEMBLE_PM_BASH_GUARD=0 disarms the guard",
  );
  // The subagent process must never register it (PM is always the parent).
  assert(
    !sub.includes("registerPmBashGuard"),
    "canary: the subagent guard does NOT register the PM bash guard (PM-only scope)",
  );
}

resetPmMode();
console.log(`\nexit ${exit}`);
process.exit(exit);
