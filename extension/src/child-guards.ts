/**
 * child-guards — the companion extension that carries the mode-independent
 * `tool_call` guards INTO spawned subagents in every mode (#926).
 *
 * The bug: the mode-independent guards were registered ONLY inside the full
 * pi-rukas extension (permission-guard.ts / permission-subagent-guard.ts).
 * spawn.ts forwarded that extension to children only in strict/headless mode;
 * a trust-mode child (the interactive default) got `PI_ENSEMBLE_TRUST_MODE=1`,
 * no broker socket, and no pi-rukas extension — so none of the guards ran in
 * the child. Live-proven: an ops child's `gh pr merge 999999 --squash`
 * reached gh.
 *
 * The fix: this file is the harness-owned companion, loaded into EVERY child
 * via `--extension <this file>` from spawn-support.ts (childGuardsArgs),
 * independent of subagentGuardEnabled / PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD /
 * PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD. It calls the shared block
 * (registerModeIndependentGuards in subagent-guard-guards.ts), which is the
 * single list of the three mode-independent guards — never the parent-only
 * ones (registerPmBashGuard stays where it is). The #716 oo-rewrite guard is
 * NOT in the shared block: it is registered by the strict/headless path in
 * permission-subagent-guard.ts, right after the shared block call, and stays
 * out of trust-mode children (see the call site there).
 *
 * No double registration in strict/headless: there the full pi-rukas
 * extension is ALSO forwarded with PI_ENSEMBLE_SUBAGENT_MODE=1 (index.ts →
 * registerPermissionGuard → registerSubagentGuard), so this file's default
 * export NO-OPS when `PI_ENSEMBLE_SUBAGENT_MODE === "1"`. A child therefore
 * has exactly one set of guard hooks in every mode.
 *
 * Codemode activation (#1030): for trust-mode children this file's
 * `session_start` handler appends `codemode` to the active tool set (via
 * enableChildCodemode in child-codemode.ts, shared with the strict path in
 * permission-subagent-guard.ts, which owns it under
 * PI_ENSEMBLE_SUBAGENT_MODE=1 — every child activates it exactly once).
 * The child-codemode flag makes both sides no-op.
 *
 * A missing file must fail the dispatch with a named error, never produce a
 * silently unguarded child — hence the preflight stat in spawn.ts
 * (spawnSpecialistInner, the #893 reporter-preflight.ts pattern).
 */

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enableChildCodemode } from "./child-codemode.ts";
import { registerModeIndependentGuards } from "./subagent-guard-guards.ts";
import { trace } from "./trace.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The child-guards companion path, resolved relative to this source file via
 * `path.dirname(fileURLToPath(import.meta.url))` (the same seam as
 * LENS_REPORTER_PATH in lens-review.ts — bare `__dirname` is not defined in
 * ESM and would only resolve under the jiti CJS shim). Loaded via
 * `--extension <path>` at spawn time — never auto-discovered from
 * `~/.pi/agent/extensions/`.
 */
export const CHILD_GUARDS_PATH = path.join(__dirname, "child-guards.ts");

/**
 * The `--extension` flags that load this companion into a child. Always
 * present, in every mode: the default export self-gates on
 * PI_ENSEMBLE_SUBAGENT_MODE, so strict/headless children (which also receive
 * the full pi-rukas extension) end up with exactly one set of guard hooks.
 */
export function childGuardsArgs(): string[] {
  return ["--extension", CHILD_GUARDS_PATH];
}

/**
 * The pre-spawn existence check for the companion (the #893
 * reporter-preflight.ts pattern): called from spawnSpecialistInner BEFORE
 * buildChildArgs, so a missing file (a stale install or restructure) is a
 * named dispatch failure, never a silently unguarded child. ANY stat failure
 * (ENOENT, EACCES, …) throws. The stat is a diagnostic (fail fast with a
 * named error), not an integrity or security boundary.
 */
export function preflightChildGuards(): void {
  try {
    statSync(CHILD_GUARDS_PATH);
  } catch (err) {
    const reason = (err as Error).message;
    throw new Error(
      `child-guards extension unavailable at ${CHILD_GUARDS_PATH}: ${reason} — run ./install.sh`,
    );
  }
}

/**
 * Register the mode-independent guards into a spawned child.
 *
 * NO-OP when `PI_ENSEMBLE_SUBAGENT_MODE === "1"`: in strict/headless mode the
 * full pi-rukas extension is also forwarded into the child and already
 * registers these guards via registerSubagentGuard — a second registration
 * would install a second `tool_call` hook and run the merge guard's gh/git
 * exec chain twice per merge attempt.
 */
export default function registerChildGuards(pi: ExtensionAPI): void {
  if (process.env.PI_ENSEMBLE_SUBAGENT_MODE === "1") {
    trace(
      "child-guards: PI_ENSEMBLE_SUBAGENT_MODE=1 — full pi-rukas extension registers the guards; no-op",
    );
    return;
  }
  // #1030 — the companion is the codemode activation site for trust-mode
  // children (the default). It deliberately runs ONLY when the guards are
  // registered below: under PI_ENSEMBLE_SUBAGENT_MODE=1 the strict path
  // (registerSubagentGuard in permission-subagent-guard.ts) performs the same
  // append instead, so every child activates codemode exactly once in every
  // mode — never here AND there.
  pi.on("session_start", () => {
    enableChildCodemode(pi);
  });
  // The shared block is the single list of the three mode-independent guards;
  // registerPmBashGuard stays parent-only (it is not in the block). All three
  // fire before any trust/sandbox bypass by construction.
  //
  // registerOoRewriteGuard (#716) is deliberately NOT registered here. The
  // strict/headless path registers it in permission-subagent-guard.ts, right
  // after its own registerModeIndependentGuards call; the companion also
  // loads into every trust-mode child, and adding the oo-rewrite there would
  // be a behaviour change outside #926's scope. See the call site in
  // permission-subagent-guard.ts.
  registerModeIndependentGuards(failClosedPi(pi));
  trace("child-guards: registered the mode-independent guards for this child");
}

/**
 * A thin ExtensionAPI wrapper that makes the `tool_call` handlers
 * fail-closed (#926 fix round).
 *
 * Exported for testing (test-child-guards-extension.ts drives the wrapper
 * directly with a throwing handler to verify the catch path).
 *
 * Pi's `emitToolCall` (dist/core/extensions/runner.js) `await`s each
 * `tool_call` handler with NO per-handler try/catch, and the caller in
 * agent-session.js re-throws into pi-agent-core's agent-loop, where the
 * tool-call prep catch converts a thrown handler into a generic
 * `isError` tool result — the command is refused with the raw error text
 * rather than the guard's named refusal, and the distinction is lost. A
 * wrapper that catches every handler error and answers `{ block: true,
 * reason }` instead turns an internal guard fault into the SAME shape a
 * deliberate refusal produces: the command is blocked, the reason is
 * named, and no fault ever lets a command through or aborts the child's
 * turn. Every other ExtensionAPI method delegates to the real pi.
 */
export function failClosedPi(pi: ExtensionAPI): ExtensionAPI {
  // The wrapper is a PROTOTYPE-INHERITING object, not a flat key copy and
  // not a Proxy. The guards bind `pi.on` at registration (e.g. `const on =
  // pi.on; on("tool_call", …)`), and a Proxy `get` trap returning a function
  // auto-binds `this` to the PROXY — so a second `pi.on` call would re-enter
  // the wrapper recursively. An `Object.keys(pi)` copy has the mirror
  // problem: it only sees pi's OWN enumerable properties, so an `on` that
  // lives on pi's prototype (non-enumerable) is missed and the wrapper
  // registers nothing while LOOKING registered. `Object.create(pi)` inherits
  // every property — own, prototype, getters — so the wrapper's identity
  // can never diverge from pi's surface, and the single OWN `on` defined
  // below shadows it for registration only. No recursion: the own `on` is
  // an own property of the wrapper (not the inherited one), and it calls
  // `pi.on.call(pi, …)` — the REAL pi's on, with `this` pinned to the real
  // pi — so the wrapped handler is installed into pi itself.
  if (typeof pi.on !== "function") {
    throw new Error(
      "child-guards: ExtensionAPI has no " + "`on`" + " — refusing to load without guards",
    );
  }
  const wrapper = Object.create(pi) as Record<string, unknown>;
  Object.defineProperty(wrapper, "on", {
    value: (event: string, handler: unknown, ...rest: unknown[]) => {
      if (event === "tool_call" && typeof handler === "function") {
        const original = handler as (e: unknown, c: unknown) => unknown;
        const wrappedHandler = async (e: unknown, c: unknown) => {
          try {
            return await original(e, c);
          } catch (err) {
            trace(
              `child-guards: tool_call guard threw — fail-closed refusal: ${(err as Error).message}`,
            );
            return {
              block: true,
              reason: `pi-rukas guard error — command refused (fail-closed): ${(err as Error).message}`,
            };
          }
        };
        (pi.on as (ev: string, h: unknown) => void).call(pi, event, wrappedHandler);
        return undefined;
      }
      return (pi.on as (ev: string, h: unknown, ...r: unknown[]) => unknown).apply(pi, [
        event,
        handler,
        ...rest,
      ]);
    },
    configurable: true,
    enumerable: true,
    writable: true,
  });
  return wrapper as unknown as ExtensionAPI;
}
