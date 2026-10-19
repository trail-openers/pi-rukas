#!/usr/bin/env bun
/**
 * Headless S5 (#1025) — the subagent guard fails CLOSED outside the sandbox.
 *
 * A headless run has no parent UI, so an `ask`-class tool call inside a child
 * has nobody to ask. The contract is that it is DENIED, with the reason that
 * names why: `"no broker socket — headless deny"`. If that string ever changes
 * the operator-facing troubleshooting entry goes stale silently, so the exact
 * text is pinned here.
 *
 * Four false-pass traps, all from the issue's own edge-case list:
 *
 *   1. `registerSubagentGuard` early-returns on `PI_ENSEMBLE_SANDBOX_MODE=1`
 *      AND on `PI_ENSEMBLE_TRUST_MODE=1` — both must be deleted, or the guard
 *      is not registered and nothing is denied.
 *   2. It early-returns when `PI_ENSEMBLE_ROLE` is unset — the role must be a
 *      real one or the tool_call passes through with no denial at all.
 *   3. The mode-independent guards run BEFORE the broker path, so
 *      `git reset --hard` would be refused by the destructive-git guard and the
 *      test would pass for the wrong reason. The probe is an `ask`-class tool
 *      the mode-independent guards ignore.
 *   4. `PI_ENSEMBLE_STRICT_PERMISSIONS=1` forces strict; a stale value from the
 *      host environment must not decide the mode either.
 *
 * The positive side is pinned too (the pattern test-permission-broker.ts
 * establishes): with a broker socket present the same call is broker-mediated,
 * NOT headless-denied. Without that half, a broken guard that denies
 * everything would pass.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrokerDeps } from "../src/permission-broker.ts";
import { startBroker } from "../src/permission-broker.ts";
import { registerSubagentGuard } from "../src/permission-subagent-guard.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

/** A fake ExtensionAPI that records tool_call handlers so the test can fire them. */
function mockPi() {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on(event: string, fn: Handler) {
      (handlers[event] ??= []).push(fn);
    },
    getActiveTools: () => ["read"],
    setActiveTools: () => undefined,
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    /** Fire every registered tool_call handler; the first blocking verdict wins. */
    async callToolCall(
      toolName: string,
      input: unknown,
    ): Promise<{ block?: boolean; reason?: string } | undefined> {
      for (const h of handlers.tool_call ?? []) {
        const r = (await h({ toolName, input }, {})) as
          | { block?: boolean; reason?: string }
          | undefined;
        if (r?.block) return r;
      }
      return undefined;
    },
  };
}

const GATED_ENVS = [
  "PI_ENSEMBLE_SANDBOX_MODE",
  "PI_ENSEMBLE_TRUST_MODE",
  "PI_ENSEMBLE_STRICT_PERMISSIONS",
  "PI_ENSEMBLE_PERM_SOCKET",
  "PI_ENSEMBLE_ROLE",
  "PI_ENSEMBLE_SUBAGENT_MODE",
  "PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT",
  "PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE",
  "PI_ENSEMBLE_ALLOW_DIRECT_ISSUE_CREATE",
  "PI_ENSEMBLE_DIR",
] as const;

const saved: Record<string, string | undefined> = {};
for (const k of GATED_ENVS) saved[k] = process.env[k];

/** Start from a clean slate: no trust, no sandbox, no socket, no overlays. */
function resetChildEnv(role: string | undefined): void {
  for (const k of GATED_ENVS) delete process.env[k];
  // An isolated agents.json so this host's ~/.pi/agent/permissions.json and the
  // repo's real grants cannot decide the verdict for the wrong reason.
  const dir = mkdtempSync(path.join(tmpdir(), "s5-agents-"));
  isolatedDirs.push(dir);
  // PI_ENSEMBLE_DIR is the documented agents.json override: an isolated file
  // means neither this host's ~/.pi/agent/permissions.json nor the repo's real
  // grants can decide the verdict for the wrong reason.
  process.env.PI_ENSEMBLE_DIR = dir;
  writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({ agent: { developer: { permission: { "*": "ask" } } } }),
  );
  if (role !== undefined) process.env.PI_ENSEMBLE_ROLE = role;
}

const isolatedDirs: string[] = [];

// ── 1. No sandbox, no trust, no role → the guard is inactive.
// The false-pass trap the issue names: with the role unset the tool_call passes
// through. Pinning it here means the deny test below cannot silently degrade
// into this shape.
{
  resetChildEnv(undefined);
  const mock = mockPi();
  registerSubagentGuard(mock.pi);
  const blocked = await mock.callToolCall("websearch", { query: "s5 probe" });
  assert(
    blocked === undefined,
    "role unset → guard inactive, the ask-class call is NOT blocked (the false-pass shape, pinned)",
  );
}

// ── 2. THE headless deny: role set, no socket, no sandbox/trust.
{
  resetChildEnv("developer");
  const mock = mockPi();
  registerSubagentGuard(mock.pi);
  const blocked = await mock.callToolCall("websearch", { query: "s5 probe" });
  assert(blocked?.block === true, "headless child: an ask-class tool call is blocked");
  assert(
    typeof blocked?.reason === "string" &&
      blocked.reason.includes("no broker socket — headless deny"),
    `the deny names the reason verbatim (got: ${blocked?.reason})`,
  );
  assert(
    blocked?.reason?.includes("websearch") === true,
    "the deny names the tool that was refused",
  );
}

// ── 3. A `git reset --hard` would be refused BEFORE the broker path.
// If that ever changes, the probe in (2) has to move — so the ordering is
// pinned rather than assumed.
{
  resetChildEnv("developer");
  const mock = mockPi();
  registerSubagentGuard(mock.pi);
  const blocked = await mock.callToolCall("bash", { command: "git reset --hard HEAD" });
  assert(
    blocked?.block === true &&
      !(blocked.reason ?? "").includes("no broker socket"),
    "the mode-independent destructive-git guard runs ahead of the broker path (the probe must stay ask-class)",
  );
}

// ── 4. Sandbox mode: every tool call passes, no deny anywhere.
{
  resetChildEnv("developer");
  process.env.PI_ENSEMBLE_SANDBOX_MODE = "1";
  const mock = mockPi();
  registerSubagentGuard(mock.pi);
  const blocked = await mock.callToolCall("websearch", { query: "s5 probe" });
  assert(
    blocked === undefined,
    "PI_ENSEMBLE_SANDBOX_MODE=1 (the sandbox image's entrypoint value) → the child runs in trust mode, nothing denied",
  );
}

// ── 5. Trust mode propagated from the parent: same pass-through.
{
  resetChildEnv("developer");
  process.env.PI_ENSEMBLE_TRUST_MODE = "1";
  const mock = mockPi();
  registerSubagentGuard(mock.pi);
  const blocked = await mock.callToolCall("websearch", { query: "s5 probe" });
  assert(
    blocked === undefined,
    "PI_ENSEMBLE_TRUST_MODE=1 → the child runs in trust mode, nothing denied",
  );
}

// ── 6. The positive side: with a broker socket the same call is broker-mediated.
{
  resetChildEnv("developer");
  const dir = mkdtempSync(path.join(tmpdir(), "s5-broker-"));
  isolatedDirs.push(dir);
  const socketPath = path.join(dir, "perm.sock");
  const seen: string[] = [];
  const deps: BrokerDeps = {
    cachedLookup() {
      return undefined;
    },
    persistDecision() {
      /* not needed for this case */
    },
    async promptUser(req) {
      seen.push(req.toolName);
      return { allowed: true, scope: "once" };
    },
  };
  const broker = startBroker(socketPath, deps);
  try {
    process.env.PI_ENSEMBLE_PERM_SOCKET = socketPath;
    const mock = mockPi();
    registerSubagentGuard(mock.pi);
    const blocked = await mock.callToolCall("websearch", { query: "s5 probe" });
    assert(
      blocked === undefined,
      "socket present → the broker's allow is honoured, not headless-denied",
    );
    assert(
      seen.length === 1 && seen[0] === "websearch",
      `the request reached the broker (seen: ${seen.join(",") || "none"})`,
    );
  } finally {
    broker.stop();
  }
}

// ── 7. A socket the broker never listens on still fails closed.
// The probe is an `ask`-class tool the mode-independent guards never look at:
// `registerDestructiveGitGuard` / the issue-creation guard / the merge guard all
// `return` unless `event.toolName === "bash"` carries a matching command, so
// with `websearch` there is exactly one guard left that can answer — the broker
// path. That is what makes the assertion below non-vacuous: a reason naming the
// broker can only have come from `escalateAsk`, not from one of the
// mode-independent guards that run ahead of it.
{
  resetChildEnv("developer");
  process.env.PI_ENSEMBLE_PERM_SOCKET = path.join(tmpdir(), "s5-no-such-listener.sock");
  const mock = mockPi();
  registerSubagentGuard(mock.pi);
  const blocked = await mock.callToolCall("websearch", { query: "s5 probe" });
  assert(
    blocked?.block === true &&
      typeof blocked.reason === "string" &&
      blocked.reason.includes("denied"),
    `an unreachable broker still denies (got: ${blocked?.reason})`,
  );
  // The reason must name the BROKER, not merely say "denied": the destructive-git
  // and merge guards also emit reasons containing that word, and a reason from
  // one of them would mean this case was never testing the broker path at all.
  assert(
    typeof blocked?.reason === "string" && /broker/.test(blocked.reason),
    `the deny names the broker as the thing that failed, so the destructive-git guard is not what blocked it (got: ${blocked?.reason})`,
  );
  assert(
    typeof blocked?.reason === "string" && !/discards uncommitted work|editor or terminal prompt/.test(blocked.reason),
    "the reason is not the destructive-git guard's wording (the ordering trap in case 3)",
  );
}

// ── 8. #1666 — the strict opt-in keeps the deny for a non-/work child. A runner with
// PI_ENSEMBLE_STRICT_PERMISSIONS=1 never stamps the /work marker (spawn-permission.ts),
// so its children run this strict guard: an ask-class call with no broker is denied.
{
  resetChildEnv("developer");
  process.env.PI_ENSEMBLE_STRICT_PERMISSIONS = "1";
  const mock = mockPi();
  registerSubagentGuard(mock.pi);
  const blocked = await mock.callToolCall("websearch", { query: "s5 probe" });
  assert(
    blocked?.block === true && (blocked.reason ?? "").includes("no broker socket — headless deny"),
    `#1666: under PI_ENSEMBLE_STRICT_PERMISSIONS=1 the strict headless deny still applies (got: ${blocked?.reason})`,
  );
}

for (const [k, v] of Object.entries(saved)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
for (const d of isolatedDirs) rmSync(d, { recursive: true, force: true });

console.log(`\nexit ${exit}`);
process.exit(exit);
