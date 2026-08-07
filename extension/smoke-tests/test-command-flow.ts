#!/usr/bin/env bun
/**
 * Smoke test for the slash-command → before_agent_start → PM-doctrine flow.
 *
 * Mocks the Pi ExtensionAPI/ExtensionCommandContext shapes my code touches,
 * runs the extension's default export, fires each slash command, and asserts:
 *   - command handler loads the right prompt body
 *   - pi.sendUserMessage receives the expanded body
 *   - before_agent_start hook appends the PM doctrine when armed
 *   - one-shot semantics: a second turn (without re-firing /command) does NOT
 *     get the doctrine
 *
 * Bypasses Pi entirely. Useful for fast iteration on extension wiring.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import extensionEntry from "../src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..");
const PROJ_DIR = path.resolve(EXT_DIR, "..");
const PI_PROMPTS = path.join(PROJ_DIR, "pi-prompts");
const PM_PROMPT = path.join(PROJ_DIR, "dist", "prompts", "standard", "project-manager.md");

interface Recorded {
  sentMessages: string[];
  notifies: Array<{ msg: string; kind?: string }>;
  registeredTools: string[];
  registeredCommands: string[];
  beforeAgentStartHandlers: Array<(event: unknown) => Promise<unknown>>;
}

function makePi() {
  const rec: Recorded = {
    sentMessages: [],
    notifies: [],
    registeredTools: [],
    registeredCommands: [],
    beforeAgentStartHandlers: [],
  };
  const pi = {
    registerTool: (def: { name: string }) => rec.registeredTools.push(def.name),
    registerCommand: (name: string, _def: unknown) => rec.registeredCommands.push(name),
    on: (event: string, handler: (e: unknown) => Promise<unknown>) => {
      if (event === "before_agent_start") rec.beforeAgentStartHandlers.push(handler);
    },
    sendUserMessage: (msg: string) => rec.sentMessages.push(msg),
    sendMessage: (_msg: string) => undefined,
    getCommands: () => [],
  };
  return { pi, rec };
}

// #360 — command handlers resolve the repo root from `ctx.cwd`, so every
// /work case passes a throwaway dir. Without it the driver writes its state
// file into this repo's own .pi/work-state/, where fixtures then collide with
// real cycles (547/548/549/551/561/789.json were all test residue).
const TMP_CWD = mkdtempSync(path.join(tmpdir(), "pi-ensemble-cmdflow-"));
// Init a real repo so `resolveRepoRoot` behaves as it does in production; a
// bare dir makes the driver throw early, and its crash-report
// `sendUserMessage` would then perturb the message counts asserted below.
execFileSync("git", ["init", "--quiet"], { cwd: TMP_CWD, stdio: "ignore" });

/** Snapshot of this repo's real state dir, compared again at exit (#360). */
const REPO_WORK_STATE = path.join(PROJ_DIR, ".pi", "work-state");
const listRepoWorkState = () =>
  existsSync(REPO_WORK_STATE) ? readdirSync(REPO_WORK_STATE).sort().join(",") : "";
const repoWorkStateBefore = listRepoWorkState();

function makeCtx(cwd: string = process.cwd()) {
  const notifies: Array<{ msg: string; kind?: string }> = [];
  const ctx = {
    isIdle: () => true,
    cwd,
    ui: {
      notify: (msg: string, kind?: string) => notifies.push({ msg, kind }),
    },
  };
  return { ctx, notifies };
}

/**
 * Prompt bodies queued by slash commands, excluding the driver's own status
 * lines. Both travel over `sendUserMessage`, but only the former is this
 * suite's subject; the driver runs fire-and-forget, so its grouping /
 * crash-report lines land at nondeterministic points and would otherwise make
 * every hardcoded count below a race (#360).
 */
const promptMessages = () => rec.sentMessages.filter((m) => !m.startsWith("pi-ensemble:"));

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Capture handlers as they register — registerCommand stores name only above,
// so we re-wire here to keep references to the actual handler fns.
const handlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
const { pi, rec } = makePi();
pi.registerCommand = (name: string, def: { handler: (a: string, c: unknown) => Promise<void> }) => {
  rec.registeredCommands.push(name);
  handlers[name] = def.handler;
};

// biome-ignore lint/suspicious/noExplicitAny: mock pi has narrower type than real ExtensionAPI
await extensionEntry(pi as any);

assert(rec.registeredCommands.includes("start"), "/start registered");
assert(rec.registeredCommands.includes("research"), "/research registered");
assert(rec.registeredCommands.includes("plan"), "/plan registered");
assert(rec.registeredCommands.includes("work"), "/work registered");
assert(rec.registeredCommands.includes("review"), "/review registered");
assert(rec.registeredCommands.includes("audit"), "/audit registered");
assert(
  rec.registeredCommands.includes("do"),
  "/do registered (PR7 — free-form work counterpart to /work)",
);
assert(rec.registeredCommands.includes("ensemble-debug"), "/ensemble-debug registered");
assert(rec.registeredCommands.includes("runs"), "/runs registered");

// PR7 — pi-prompts/do.md exists and uses the expected placeholders +
// toolkit mentions. /do is PM-driven; its body is loaded from disk on
// every invocation (no compiled driver code path).
{
  const doBody = await fs.readFile(path.join(PI_PROMPTS, "do.md"), "utf8");
  assert(doBody.length > 500, "pi-prompts/do.md exists and is non-trivial");
  assert(
    doBody.includes("$ARGUMENTS"),
    "pi-prompts/do.md uses $ARGUMENTS (consumed by expandArgs in commands.ts)",
  );
  assert(
    doBody.includes("dispatch_specialist"),
    "pi-prompts/do.md mentions dispatch_specialist (PM orchestration toolkit)",
  );
  assert(
    doBody.includes("adversarial_loop"),
    "pi-prompts/do.md mentions adversarial_loop (non-negotiable commit gate)",
  );
}
assert(rec.registeredTools.includes("dispatch_specialist"), "dispatch_specialist tool registered");
assert(rec.registeredTools.includes("dispatch_parallel"), "dispatch_parallel tool registered");
assert(rec.registeredTools.includes("adversarial_loop"), "adversarial_loop tool registered");
assert(
  rec.registeredTools.includes("dispatch_lens_review"),
  "dispatch_lens_review tool registered",
);
assert(rec.beforeAgentStartHandlers.length === 1, "exactly one before_agent_start hook");

// Verify pi-prompts files exist. #393 removed "work" — /work is the compiled
// driver and has no prompt file; a stale work.md would be documentation that
// reads as authoritative while matching nothing the driver actually does.
for (const name of ["start", "research", "plan", "review", "do"]) {
  const file = path.join(PI_PROMPTS, `${name}.md`);
  const exists = await fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
  assert(exists, `pi-prompts/${name}.md exists`);
}
const pmExists = await fs
  .stat(PM_PROMPT)
  .then(() => true)
  .catch(() => false);
assert(pmExists, "PM doctrine prompt built (dist/prompts/standard/project-manager.md)");

// Fire /start with no args
const { ctx: ctx1 } = makeCtx();
await handlers.start!("", ctx1);
assert(promptMessages().length === 1, "/start → 1 message queued");
const startBody = await fs.readFile(path.join(PI_PROMPTS, "start.md"), "utf8");
assert(
  promptMessages()[0] === startBody,
  "/start: queued message equals start.md body (no $ARGUMENTS in start.md, so no expansion)",
);

// Fire /review #456 (with arg expansion)
const { ctx: ctxR } = makeCtx();
await handlers.review!("#456", ctxR);
assert(promptMessages().length === 2, "/review #456 → second message queued");
assert(
  promptMessages()[1].includes("**Scope**: #456"),
  "/review #456: $ARGUMENTS expanded to '#456' in workflow body",
);

// #393 — /work has NO prompt path any more. It always runs the compiled
// driver, so unlike every other command it must not queue a message. The
// assertion this replaces set PI_ENSEMBLE_WORK_DRIVER=0 and checked that
// work.md was sent verbatim; both the flag and work.md are deleted.
{
  {
    const { ctx: ctxW, notifies: notifW } = makeCtx(TMP_CWD);
    await handlers.work!("789", ctxW);
    assert(
      promptMessages().length === 2,
      "/work 789: does NOT call sendUserMessage — there is no prose flow to send",
    );
    assert(
      notifW.some((n) => n.kind === "info" && /work-state\/789\.json/.test(n.msg)),
      "/work 789: info notify names the work-state file path",
    );
    assert(
      notifW.every((n) => !/PI_ENSEMBLE_WORK_DRIVER|legacy/i.test(n.msg)),
      "...and no message advertises a legacy fallback that no longer exists",
    );
  }
}

// /work without an issue number should reject cleanly (warning notify, no
// sendUserMessage).
{
  {
    const { ctx: ctxWE, notifies: notifWE } = makeCtx(TMP_CWD);
    await handlers.work!("", ctxWE);
    assert(promptMessages().length === 2, "/work (no args): does NOT send a message");
    assert(
      notifWE.some((n) => n.kind === "warning" && /issue number/.test(n.msg)),
      "/work (no args): warning notify mentions missing issue number",
    );
  }
}

// PR16 — /work N M P (multi-issue) now runs a DETERMINISTIC GROUPING
// pass at the entry point (groupIssues) and then iterates the resulting
// groups sequentially (halt-on-non-merged). Related issues share one
// PR (via the PR10 bundled driver-level API); unrelated issues run as
// separate cycles.
//
// This test only asserts the immediate notify (analyzing…); the actual
// grouping + iteration happens in the background fire-and-forget
// coroutine (which needs `gh issue view` we can't mock here — that's
// exercised by the groupIssues unit tests in test-work-driver.ts).
{
  {
    const { ctx: ctxMulti, notifies: notifMulti } = makeCtx(TMP_CWD);
    await handlers.work!("561 562 563", ctxMulti);
    assert(
      promptMessages().length === 2,
      "/work 561 562 563: does NOT call sendUserMessage synchronously",
    );
    assert(
      notifMulti.some(
        (n) =>
          n.kind === "info" &&
          /analyzing 3 issues/.test(n.msg) &&
          /#561, #562, #563/.test(n.msg) &&
          /grouping/.test(n.msg),
      ),
      "/work 561 562 563: info notify names all 3 issues + 'analyzing…grouping' phrasing",
    );
  }
}

// PR12 — /work N --restart should parse the flag (order-independent)
// and the notify includes the "(restart — prior state wiped)" tag.
{
  {
    // Trailing --restart.
    const { ctx: ctxR1, notifies: notifR1 } = makeCtx(TMP_CWD);
    await handlers.work!("547 --restart", ctxR1);
    assert(
      notifR1.some(
        (n) =>
          n.kind === "info" && /issue #547/.test(n.msg) && /restart.*prior state wiped/.test(n.msg),
      ),
      "/work 547 --restart: notify includes restart tag",
    );
    // Leading --restart.
    const { ctx: ctxR2, notifies: notifR2 } = makeCtx(TMP_CWD);
    await handlers.work!("--restart 548", ctxR2);
    assert(
      notifR2.some(
        (n) =>
          n.kind === "info" && /issue #548/.test(n.msg) && /restart.*prior state wiped/.test(n.msg),
      ),
      "/work --restart 548: --restart order-independent (leading)",
    );
    // Multi-issue + --restart in the middle.
    //
    // PR16 — the immediate notify is the "analyzing…" line (grouping
    // pass runs in the background). The --restart tag surfaces later
    // in the sendUserMessage grouping-decision line, not the notify.
    const { ctx: ctxR3, notifies: notifR3 } = makeCtx(TMP_CWD);
    await handlers.work!("549 --restart 550", ctxR3);
    assert(
      notifR3.some(
        (n) => n.kind === "info" && /analyzing 2 issues/.test(n.msg) && /#549, #550/.test(n.msg),
      ),
      "/work 549 --restart 550: --restart filtered out of issue parse, multi-issue analyzing phrasing intact",
    );
    // Plain /work N (no --restart) — no restart tag in notify.
    const { ctx: ctxR4, notifies: notifR4 } = makeCtx(TMP_CWD);
    await handlers.work!("551", ctxR4);
    assert(
      notifR4.some((n) => n.kind === "info" && /issue #551/.test(n.msg) && !/restart/i.test(n.msg)),
      "/work 551 (no flag): notify does NOT include restart tag (regression guard)",
    );
  }
}

// Fire before_agent_start with doctrine armed (set by the most recent /work call)
const hook = rec.beforeAgentStartHandlers[0]!;
const result1 = (await hook({ systemPrompt: "PI_BASE_PROMPT" })) as
  | { systemPrompt: string }
  | undefined;
assert(result1 !== undefined, "before_agent_start returns a result when armed");
assert(
  (result1?.systemPrompt ?? "").startsWith("PI_BASE_PROMPT\n\n"),
  "before_agent_start: appends to existing systemPrompt (does not replace)",
);
const pmBody = await fs.readFile(PM_PROMPT, "utf8");
assert(
  (result1?.systemPrompt ?? "").includes(pmBody.slice(0, 200)),
  "before_agent_start: PM doctrine body is included",
);

// Second call without re-firing /command: PM mode is sticky for the
// remainder of the session, so the sticky preamble must still be appended
// (closes the "PM forgets the doctrine on turn 2+" bug). The FULL doctrine
// is one-shot though — only the short preamble appears on turn 2.
const result2 = await hook({ systemPrompt: "PI_BASE_PROMPT" });
assert(
  result2?.systemPrompt !== undefined &&
    result2.systemPrompt.includes("PM mode — orchestration only"),
  "before_agent_start: sticky preamble appended on turn 2 (PM mode active)",
);
assert(
  !(result2?.systemPrompt ?? "").includes(pmBody.slice(0, 200)),
  "before_agent_start: FULL doctrine NOT re-injected on turn 2 (cost-bounded one-shot)",
);

// Fire /start when busy — should refuse and not arm
const { ctx: ctx3, notifies: notif3 } = makeCtx();
ctx3.isIdle = () => false;
await handlers.start!("", ctx3);
assert(
  promptMessages().length === 2,
  "/start while busy: no new message queued (still 2 from earlier)",
);
assert(
  notif3.some((n) => n.kind === "warning"),
  "/start while busy: user is notified",
);
// Even when /start is refused, PM mode stays active from the earlier successful
// /start so the sticky preamble is still appended. The state didn't regress.
const result3 = await hook({ systemPrompt: "PI_BASE_PROMPT" });
assert(
  result3?.systemPrompt !== undefined &&
    result3.systemPrompt.includes("PM mode — orchestration only"),
  "/start while busy: PM mode sticky preamble still active from earlier /start",
);

// PR7 — Fire /do <description>. PM-driven, no driver path; same shape
// as /research / /plan. Placed at the end so the earlier hardcoded
// sentMessages.length === N assertions don't shift.
{
  const { ctx: ctxDo } = makeCtx();
  const before = promptMessages().length;
  await handlers.do!("fix the typo in README.md", ctxDo);
  assert(
    promptMessages().length === before + 1,
    "/do <description> → 1 message queued (PM-driven, no driver detour)",
  );
  assert(
    promptMessages()[before].includes("**Request**: fix the typo in README.md"),
    "/do: $ARGUMENTS expanded into the **Request** field of do.md",
  );
}

// #360 — the driver runs fire-and-forget, so give any stray background write
// a chance to land before asserting the repo's own state dir is untouched.
// Pre-#360 this suite left 547/548/549/551/561/789.json behind on every run.
await new Promise((r) => setTimeout(r, 250));
assert(
  listRepoWorkState() === repoWorkStateBefore,
  "/work cases honour ctx.cwd — repo .pi/work-state/ is unchanged by the suite",
);
rmSync(TMP_CWD, { recursive: true, force: true });

console.log("\n=== test-command-flow summary ===");
console.log(
  `registered: ${rec.registeredCommands.length} commands, ${rec.registeredTools.length} tools`,
);
console.log(`exit ${exit}`);
process.exit(exit);
