#!/usr/bin/env bun
/**
 * lean/publish — the push is non-interactive.
 *
 * `git push` is the step's only write OUTSIDE the clone, and it is the one git
 * call in the harness that can park forever on a prompt: `GIT_TERMINAL_PROMPT=0`
 * closes the HTTPS credential prompt, and ssh reads a key passphrase from
 * /dev/tty regardless — so a vanished forwarded agent needs `-o BatchMode=yes`
 * to make it FAIL rather than wait (the #1095 shape, measured at ~5h).
 *
 * Two halves, both pinned: the env is the DRIVER'S (`netGitEnv` from
 * `work-driver-net-git.ts`, so a lean push and a driver push cannot drift apart
 * on what makes ssh fail rather than wait) and the step's own behaviour — every
 * git child the publish step spawns ran with both levers on, which is the
 * guarantee that actually matters, since the helper being correct and never being
 * applied is the same failure.
 */

import { PublishInfraError } from "../src/lean/publish-deps.ts";
import { netGitEnv } from "../src/work-driver-net-git.ts";
import { fakePr } from "./lib/lean-publish-forge.ts";
import { ROOTS, originHead, runPublish } from "./lib/lean-publish-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------- the env IS the driver's, not a copy of it
{
  const bare = netGitEnv({});
  assert(
    bare.GIT_TERMINAL_PROMPT === "0",
    `(n) the push cannot stop on an HTTPS credential prompt (${bare.GIT_TERMINAL_PROMPT})`,
  );
  assert(
    (bare.GIT_SSH_COMMAND ?? "").includes("BatchMode=yes"),
    `(n) ssh fails rather than reading a passphrase from the tty (${bare.GIT_SSH_COMMAND})`,
  );
  const operator = netGitEnv({ GIT_SSH_COMMAND: "ssh -i /keys/deploy" });
  assert(
    operator.GIT_SSH_COMMAND === "ssh -i /keys/deploy -o BatchMode=yes -o ConnectTimeout=30",
    `(n) an operator's ssh command is kept verbatim, the defaults appended (${operator.GIT_SSH_COMMAND})`,
  );
  const wrapped = netGitEnv({ GIT_SSH_COMMAND: "plink -i /keys/deploy" });
  assert(
    /^plink -i \/keys\/deploy/.test(wrapped.GIT_SSH_COMMAND ?? ""),
    `(n) a non-OpenSSH program stays the program the operator chose (${wrapped.GIT_SSH_COMMAND})`,
  );
}

// ------------- (n1) the repo's own core.sshCommand survives into the push env
//
// The production seam must hand `netGitEnv` the child's cwd: the ssh selection
// git itself would use is GIT_SSH_COMMAND, then the repo's `core.sshCommand`,
// then GIT_SSH, then `ssh`, and the cwd is the only way the middle one is read.
// A cwd-less call promotes plain `ssh` and outranks a repo that chose its key
// with `git config core.sshCommand` — the same bug an unconditional
// GIT_SSH_COMMAND is (#1095).
{
  const r = await runPublish({
    issue: 434,
    verify: { kind: "green" },
    sshCommand: "ssh -i /k",
  });
  assert(
    r.outcome?.kind === "ok",
    `(n1) a repo with its own core.sshCommand still publishes (${r.threw?.message})`,
  );
  const push = r.gitEnvs[r.gitEnvs.length - 1];
  const ssh = push?.GIT_SSH_COMMAND ?? "";
  assert(
    ssh.includes("-i /k") && ssh.includes("BatchMode=yes"),
    `(n1) the push env keeps the repo's ssh command AND adds BatchMode (${ssh})`,
  );
}

// ------------------------------------------ the step applies it to every git child
{
  const r = await runPublish({ issue: 430, verify: { kind: "green" } });
  assert(
    r.outcome?.kind === "ok",
    `(n) a push through the non-interactive env still succeeds (${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-430") === r.head,
    `(n) origin holds the pushed head (${originHead(r.origin, "lean/issue-430")})`,
  );
  // The fixture's executor applies the same rule the production seam does
  // (`git` with no caller env gets the publish push env), so `gitEnvs` is what
  // the step's children actually ran with. Every read-only probe and the push
  // are `git` calls, so this is the whole step — and none of them may prompt.
  const prompted = r.gitEnvs.filter(
    (e) => e.GIT_TERMINAL_PROMPT !== "0" || !(e.GIT_SSH_COMMAND ?? "").includes("BatchMode=yes"),
  );
  assert(
    r.gitEnvs.length > 0 && prompted.length === 0,
    `(n) every git child ran with GIT_TERMINAL_PROMPT=0 and BatchMode (${r.gitEnvs.length} children, ${prompted.length} without it)`,
  );
}

// ------------- the env cannot turn a foreign branch into a silent ok
//
// The lease is always bound to the sha the step read, so what keeps a foreign
// branch safe is not git's non-fast-forward rule — it is the forge's open-PR
// read before the push. A non-interactive env must not weaken that check.
{
  const r = await runPublish({
    issue: 431,
    verify: { kind: "green" },
    originForeign: true,
    openPrs: [fakePr(97, "https://forge.example/pull/97", "lean/issue-431")],
  });
  assert(
    r.threw instanceof PublishInfraError,
    `(n) the non-interactive env does not rescue a push over a branch under review (got ${r.threw?.name})`,
  );
  assert(
    originHead(r.origin, "lean/issue-431") !== r.head,
    "(n) this run's head was not published over the foreign branch — the env is about prompts, not force",
  );
}

// ------------- (n2) a prDraft that left the PR ready is caught by reading it back
//
// The push has already landed when `prDraft` runs, so a forge that accepted the
// call and changed nothing would hand the engine an `ok` outcome with a mergeable
// PR standing behind bytes nothing verified. The step reads the PR back and
// refuses unless the forge reports `isDraft === true`.
{
  const ready = fakePr(95, "https://forge.example/pull/95", "lean/issue-432", false);
  const r = await runPublish({
    issue: 432,
    verify: { kind: "red" },
    noPush: true,
    openPrs: [ready],
    afterDraft: { 95: false },
  });
  assert(
    r.threw instanceof PublishInfraError && /does not report itself a draft/.test(r.threw.message),
    `(n2) a prDraft that left the PR ready is a refusal, not an ok (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    r.threw?.message.includes("pushed ") === true,
    `(n2) the refusal says the push landed (${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-432") === r.head,
    "(n2) the work is on origin — which is exactly why the message must say so",
  );
  assert(
    r.forge.prDraftCalls.length === 1 && r.forge.prViewCalls.includes(95),
    `(n2) the forge was asked to draft and then read back (${JSON.stringify(r.forge.prDraftCalls)}, ${JSON.stringify(r.forge.prViewCalls)})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
