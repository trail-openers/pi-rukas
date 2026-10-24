#!/usr/bin/env bun
/**
 * #1113 — no developer subagent pushes.
 *
 * The doctrine said it in four places. Nothing enforced it, in either of the
 * two ways a bash command gets gated:
 *
 *   - `agents.json` GRANTED it (`"git push*": "allow"` + `"oo git push*":
 *     "allow"` in the developer bash map), so in the two modes that read the
 *     map the verdict was allow;
 *   - trust mode (the interactive default) and sandbox mode (the container
 *     default) return before any verdict resolution, so the map is decorative
 *     there and no other hook spoke to `git push` at all.
 *
 * On 2026-10-11 PM dispatch briefs told developers to rebase and
 * `git push --force-with-lease` on PRs #1063 / #1109 / #1110, repeatedly, and
 * they complied. A refusal that lives after the bypasses, or only in the
 * allowlist, is a refusal that never runs — so this guard sits in
 * `registerModeIndependentGuards`, ahead of every bypass, like #926's
 * destructive-git guard and #912's merge guard.
 *
 * Three layers are asserted, because each has failed independently before:
 *   A. the pure matcher (`git-push-command.ts`) — table, both directions;
 *   B. the ROLE split through the real hook — developer refused, ops and the
 *      un-set parent role allowed, and a commit still allowed (the guard must
 *      not eat the work the develop gate requires);
 *   C. canaries — the guard is in the shared block, before the bypasses, and
 *      the companion's expected-guard set includes it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { resetPublicHygieneRegistrationForTests } from "../src/public-hygiene-guard.ts";
import { registerDeveloperPushGuard } from "../src/developer-push-guard.ts";
import { executedBodies, pushRunsCommand, pushesRemote } from "../src/git-push-command.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ============================================================
// A. The matcher — every push form the issue names, refused.
// ============================================================
for (const cmd of [
  "git push",
  "git push --force",
  "git push --force-with-lease",
  "git push --force-with-lease origin feature/x",
  "git push origin HEAD:main",
  "git push origin :old-topic",
  "git push --delete origin old-branch",
  "git -C /repo/.worktrees/issue-1113 push",
  "git -C . push origin main",
  "git -c push.default=current push",
  "git --git-dir=/repo/.git --work-tree=/repo push",
  "git --no-pager push",
  "oo git push",
  "oo git push origin main",
  "env GIT_TRACE=1 git push",
  "timeout 30 git push",
  "cd /repo && git push",
  "git add -A && git commit -m x && git push",
  "git status; git push",
  // The payload-in-a-shell forms: `stripQuotedSegments` REMOVES these, so a
  // matcher that only strips reads "nothing here" and lets the push through.
  'bash -c "git push"',
  "bash -c 'git push origin main'",
  'sh -c "git push --force"',
  "zsh -c 'git push'",
  // A push that also does other things in the same shell payload.
  'bash -c "git add -A && git commit -m wip && git push"',
]) {
  assert(pushesRemote(cmd) !== undefined, `matcher: refused — ${cmd}`);
}

// ------------------------------------------------ and it does not overreach
// A developer that cannot run `git log` cannot do its job, so the read side is
// as much a contract as the refuse side.
for (const cmd of [
  "git status --porcelain",
  "git diff --cached",
  "git log --oneline -10",
  "git add -A",
  "git commit -m 'feat(x): y'",
  "git commit --amend --no-edit",
  "git fetch origin",
  "git remote -v",
  "git worktree list",
  "git stash push -m wip",
  "git pushmirror",
  "git pusher --help",
  "git log origin/main..origin/push-handling",
  "git grep 'push,' -- src/",
  "git config --get remote.origin.url",
  // MENTIONS of the verb in prose are not the verb.
  'echo "git push"',
  "gh pr comment 5 --body 'the developer must not git push'",
  "git commit -m 'fix: stop the job that does git push'",
  // The shape that actually bricked a commit while this guard was in tests:
  // the quoted message is BLANKED before matching (`git commit -m "."`), so a
  // walk that consumed a value word after a flag crossed the segment boundary
  // and matched the later bare `push` — refusing the very commit the develop
  // gate requires. The second form has no `-m` at all, which is the same trap
  // reached by a different route.
  "git commit -m 'do not push'",
  "git commit -m 'add push handling to the docs'",
  "git add -A && git commit -m 'docs: mention push'",
  'bash -c "ls -la"',
  "npm test",
]) {
  assert(pushesRemote(cmd) === undefined, `matcher: allowed — ${cmd}`);
}

// --------------------------------- the shell-body path is a real path, not luck
{
  const hidden = 'bash -c "git push origin main"';
  assert(pushRunsCommand(hidden) !== undefined, "body path: catches the shell payload");
  assert(executedBodies(hidden).length > 0, "body path: the payload was extracted");
  // A quoted word that is a STRING, not a program, yields no body — which is
  // what keeps `echo "git push"` open while `bash -c "git push"` closes.
  assert(executedBodies('echo "git push"').length === 0, "body path: prose yields no body");
  assert(pushesRemote('echo "git push"') === undefined, "body path: prose stays allowed");
  // A `-c` that belongs to a non-shell program is not a shell payload.
  assert(executedBodies("grep -c 'push' src/x.ts").length === 0, "body path: grep -c is no shell");
}

// ============================================================
// B. The role split, driven through the REAL hook.
// ============================================================
type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function makeFakePi() {
  const handlers: Record<string, Handler[]> = {};
  return {
    handlers,
    on(name: string, fn: Handler) {
      (handlers[name] ??= []).push(fn);
    },
  };
}

async function refuse(fake: { handlers: Record<string, Handler[]> }, command: string) {
  const results = await Promise.all(
    (fake.handlers["tool_call"] ?? []).map((h) => h({ toolName: "bash", input: { command } }, {})),
  );
  for (const r of results) {
    const o = r as { block?: boolean; reason?: string } | undefined;
    if (o && typeof o === "object" && o.block === true) return o;
  }
  return undefined;
}

const prevRole = process.env.PI_ENSEMBLE_ROLE;
function withRole(role: string | undefined, fn: () => Promise<void>): Promise<void> {
  if (role === undefined) delete process.env.PI_ENSEMBLE_ROLE;
  else process.env.PI_ENSEMBLE_ROLE = role;
  return fn();
}

{
  // A developer child is refused, in every form.
  const fake = makeFakePi();
  registerDeveloperPushGuard(fake as unknown as ExtensionAPI);
  for (const cmd of [
    "git push",
    "git push --force-with-lease origin feature/issue-1113",
    "git -C .worktrees/issue-1113 push origin main",
    "oo git push",
    'bash -c "git push"',
  ]) {
    const r = await withRole("developer", async () => refuse(fake, cmd));
    assert(r?.block === true, `developer: hook refuses \`${cmd}\``);
    assert(
      r?.reason !== undefined && /@ops/.test(r.reason ?? ""),
      `developer: the refusal for \`${cmd}\` names @ops as the owner of the push`,
    );
    assert(
      r?.reason !== undefined && /git commit/.test(r.reason ?? ""),
      `developer: the refusal for \`${cmd}\` names the route that IS open (commit in the worktree)`,
    );
  }
  // And the work the develop gate REQUIRES stays open — a guard that refuses
  // `git add`/`git commit` reproduces #621's 100% develop-step failure.
  for (const cmd of [
    "git add -A",
    "git commit -m 'fix(x): y'",
    "git commit -m 'feat: wire the push-retry path'",
    "git commit -m 'docs: document why git push is @ops work'",
    "git status --porcelain",
    "git log --oneline -5",
    "git diff HEAD",
    "git fetch origin",
  ]) {
    const r = await withRole("developer", async () => refuse(fake, cmd));
    assert(r === undefined, `developer: \`${cmd}\` stays allowed (the develop gate needs it)`);
  }
}

{
  // Ops pushes by design — the same hook, the same command, a different role.
  const fake = makeFakePi();
  registerDeveloperPushGuard(fake as unknown as ExtensionAPI);
  for (const cmd of ["git push", "git push -u origin feature/issue-1113", "git push --force"]) {
    const r = await withRole("ops", async () => refuse(fake, cmd));
    assert(r === undefined, `ops: \`${cmd}\` is NOT refused (ops owns the push)`);
  }
  // The parent session and the other roles are untouched: PM resolves when
  // PI_ENSEMBLE_ROLE is unset (permission-guard.ts's fallback), and a guard
  // that keyed on "not developer" would reach it.
  for (const role of ["explore", "code-review-specialist", "adversarial-developer", undefined]) {
    const fake2 = makeFakePi();
    registerDeveloperPushGuard(fake2 as unknown as ExtensionAPI);
    const r = await withRole(role, async () => refuse(fake2, "git push"));
    assert(r === undefined, `role=${role ?? "<unset>"}: \`git push\` is not this guard's business`);
  }
}

{
  // The operator escape hatch is checked at REGISTRATION, not per call: once
  // the operator has said so, the hook is inert for the session.
  process.env.PI_ENSEMBLE_ALLOW_DEVELOPER_PUSH = "1";
  const fake = makeFakePi();
  registerDeveloperPushGuard(fake as unknown as ExtensionAPI);
  const n = fake.handlers["tool_call"]?.length ?? 0;
  assert(n === 0, `opt-out: PI_ENSEMBLE_ALLOW_DEVELOPER_PUSH=1 registers no hook (got ${n})`);
  delete process.env.PI_ENSEMBLE_ALLOW_DEVELOPER_PUSH;
}

if (prevRole === undefined) delete process.env.PI_ENSEMBLE_ROLE;
else process.env.PI_ENSEMBLE_ROLE = prevRole;

// ============================================================
// B2. Through the COMPANION itself, not just the guard. The bug was that a
//     trust-mode child receives nothing but this companion (`spawn.ts` →
//     `childGuardsArgs()`), so registering the guard in the shared block is
//     only half the fix — the other half is that the companion's loaded hook
//     set actually refuses the push. The role is read from the child's env,
//     which is exactly what the spawn does (`{ ...process.env,
//     PI_ENSEMBLE_ROLE: spec.role }`). Same fake-pi shape as
//     test-child-guards-extension.ts, so the two files stay independent.
// ============================================================
{
  const fake2 = makeFakePi();
  const prevRole = process.env.PI_ENSEMBLE_ROLE;
  // #1788 round 2 — the companion also installs the public hygiene guard, and
  // that guard's push scan now reads git for real (it used to be registered
  // with no executor, so it asked nothing). This fixture's cwd is not a clone
  // with a github.com remote, so the scan reports an unreadable range — which
  // is the hygiene guard doing its job, not the role ban, and left alone it
  // would read as "ops may not push". The role question is what this block
  // asserts, so the publish check is switched off for these four calls only
  // (the same escape hatch an operator uses), on a scratch denylist path that
  // can never reach the operator's real list.
  process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = "/nonexistent/pi-rukas-test-denylist";
  process.env.PI_ENSEMBLE_PUBLIC_HYGIENE = "0";
  resetPublicHygieneRegistrationForTests();
  childGuards(fake2 as unknown as ExtensionAPI);
  process.env.PI_ENSEMBLE_ROLE = "developer";
  const pushed = await refuse(fake2, "git push origin feature/issue-1113");
  assert(pushed?.block === true, "companion: a developer's `git push` is refused end to end");
  assert(
    pushed?.reason !== undefined && /@ops/.test(pushed.reason),
    "companion: the refusal names @ops as the owner of the push",
  );
  const committed = await refuse(fake2, "git commit -m 'fix(x): y'");
  assert(
    committed === undefined,
    "companion: a developer's `git commit` still passes (the develop gate requires it)",
  );
  process.env.PI_ENSEMBLE_ROLE = "ops";
  const opsPush = await refuse(fake2, "git push -u origin feature/issue-1113");
  assert(opsPush === undefined, "companion: the same push is allowed for role=ops");
  delete process.env.PI_ENSEMBLE_PUBLIC_HYGIENE;
  delete process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
  if (prevRole === undefined) delete process.env.PI_ENSEMBLE_ROLE;
  else process.env.PI_ENSEMBLE_ROLE = prevRole;
}

// ============================================================
// C. Canaries — placement, and the shared block.
// ============================================================
{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const block = readFileSync(path.join(SRC, "subagent-guard-guards.ts"), "utf8");
  const sub = readFileSync(path.join(SRC, "permission-subagent-guard.ts"), "utf8");
  const companion = readFileSync(path.join(SRC, "child-guards.ts"), "utf8");
  const guard = readFileSync(path.join(SRC, "developer-push-guard.ts"), "utf8");

  assert(
    /registerDeveloperPushGuard\(pi\)/.test(block),
    "canary: the shared block registers registerDeveloperPushGuard(pi)",
  );
  assert(
    !/registerDeveloperPushGuard\(pi\)/.test(companion),
    "canary: the companion does NOT register it directly (the shared block is the single list)",
  );
  const callIdx = sub.indexOf("registerModeIndependentGuards(pi)");
  const sandboxIdx = sub.indexOf("PI_ENSEMBLE_SANDBOX_MODE");
  const trustIdx = sub.indexOf("PI_ENSEMBLE_TRUST_MODE");
  assert(
    callIdx > 0 && callIdx < sandboxIdx && callIdx < trustIdx,
    `canary: the shared block is registered BEFORE both bypasses (call=${callIdx}, sandbox=${sandboxIdx}, trust=${trustIdx}) — after them it never runs, since both are defaults`,
  );
  // The role is read in the HOOK BODY, never at registration: the same module
  // loads into the parent (PM) and into every role's child, and a
  // registration-time decision would either brick PM or skip the child.
  assert(
    /if \(!isDeveloperChild\(\)\) return/.test(guard),
    "canary: the role is tested inside the tool_call handler, not at registration",
  );
  assert(
    /PI_ENSEMBLE_ROLE === DEVELOPER_ROLE/.test(guard) ||
      /process\.env\.PI_ENSEMBLE_ROLE/.test(guard),
    "canary: the role comes from PI_ENSEMBLE_ROLE (the same primitive oo-rewrite-guard keys on)",
  );
  assert(
    /PI_ENSEMBLE_ALLOW_DEVELOPER_PUSH/.test(guard),
    "canary: an operator opt-out exists",
  );
  // Fail closed: an empty command must not read as "not a push" from a missing
  // input — the handler reads the field defensively.
  assert(
    /event\.input as \{ command\?: string \}\)\?\.command \?\? ""/.test(guard),
    "canary: the command is read defensively (a missing input never throws open)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
