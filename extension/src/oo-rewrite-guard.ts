/**
 * oo-rewrite-guard — the silent rewrite of bare verbose-runner bash commands
 * to their `oo`-prefixed form for developer + ops subagents.
 *
 * The doctrine (modules/core/oo-command-runner.md, agents-base/developer.md)
 * makes the `oo` prefix mandatory for 12 verbose runners, but on the bash
 * tool's argument string that rule is pure prose: the only structural
 * enforcement layer (spawn.ts --exclude-tools / role-tools.ts) can remove
 * NAMED tools, not a bash-string distinction like `pytest` vs `oo pytest`.
 * Prose tool-preference is the least reliable enforcement mechanism in the
 * literature, so this hook enforces it deterministically: a bare 12-item
 * command at the START of the quote-stripped command string is rewritten
 * in-place to `oo <cmd>` in event.input.command, which Pi documents as
 * mutable — later tool_call handlers (the legacy subagent guard's verdict
 * handler) see the rewritten string, so in trust/sandbox mode a bare
 * `cargo test` routes through the existing `oo cargo test*` allow row
 * instead of relying on the model remembering the prefix.
 *
 * REWRITE ONLY — no block/deny path of any kind. This hook must NEVER return
 * `{ block: true }` for any input; a no-match is a pass-through, not a
 * refusal.
 *
 * Registration placement (mirrors registerDestructiveGitGuard /
 * registerIssueCreationGuard in permission-subagent-guard.ts): BEFORE the
 * sandbox-mode and trust-mode early returns, so the hook is registered in
 * every subagent process. The mode split is NOT achieved by placement — it
 * is an explicit guard clause in the hook body:
 *
 *   fire only when PI_ENSEMBLE_SANDBOX_MODE === "1" OR
 *   PI_ENSEMBLE_TRUST_MODE === "1".
 *
 * Why that exact gate (not a PI_ENSEMBLE_STRICT_PERMISSIONS check): spawn.ts
 * never sets PI_ENSEMBLE_STRICT_PERMISSIONS in the child env, and a strict-
 * parent child (PI_ENSEMBLE_SUBAGENT_MODE=1 + PI_ENSEMBLE_PERM_SOCKET, no
 * trust marker) is indistinguishable from a headless child inside the hook.
 * The gate above reads the SAME two primitives the legacy subagent guard's
 * own short-circuits read, so "legacy guard would short-circuit" (hook
 * fires) vs "legacy guard resolves verdicts" (hook inert) is a precise,
 * testable split — byte-identical behaviour in strict/headless children,
 * where the agents.json deny rows for bare pytest/cargo test/etc. are
 * reached exactly as today.
 *
 * Role-scoped: fires only when PI_ENSEMBLE_ROLE is exactly "developer" or
 * "ops" — the two roles whose doctrine prescribes mandatory oo. Read inside
 * the hook body (not at registration) so parent/PM and the other four
 * subagent roles stay untouched.
 *
 * Graceful degradation (operator's non-negotiable condition): not every
 * host has `oo` installed. The binary is probed ONCE at registration time
 * (injectable for tests); if absent, the hook is inert for the whole
 * session — a single debug-gated trace() line explains why, no per-call
 * re-probing, no per-call warning — and bare commands execute exactly as
 * today.
 *
 * Documented limitation (no mechanism, no test): with
 * PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1 (spawn-extension-forward.ts) the
 * pi-rukas extension is not forwarded to subagent children at all, so this
 * hook simply never exists there — the harness continues working exactly as
 * it does today.
 */

import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BASH_COMMAND_INJECTION_CHARS, stripQuotedSegments } from "./bash-command-parser.ts";
import { trace } from "./trace.ts";

/**
 * The 12 bare verbose-runner commands the doctrine mandates the `oo` prefix
 * for (modules/core/oo-command-runner.md lines 7-11 — including the
 * corrected `bun run build`, not the non-existent `bun build`). Each entry
 * is the full bare token sequence as it appears at the START of a command.
 */
const OO_PREFIXES = [
  "pytest",
  "cargo test",
  "cargo clippy",
  "cargo build",
  "cargo nextest",
  "bun test",
  "bun run build",
  "npm test",
  "npm run build",
  "pnpm test",
  "yarn test",
  "go test",
] as const;

/**
 * Pure rewrite predicate. Returns the matched bare prefix when the
 * QUOTE-STRIPPED command starts with one of the 12 items as a complete
 * word-boundary token sequence, else undefined.
 *
 * Anchored at ^ by construction (the descriptor limits the rewrite to the
 * START of the string): `cd x && cargo test` does NOT match. No
 * wrapper-stripping: `timeout 30 cargo test`, `nice -n 5 bun test`,
 * `env FOO=1 pytest` do NOT match (wrapper-prefixed commands are explicitly
 * out of scope, and stripLeadingWrappers is deliberately not used).
 *
 * Word-boundary semantics mirror matchBashSubcommand's ` *` matching
 * (command === prefix || startsWith(prefix + " ")), so `bun test2` /
 * `bun tests/` do NOT match `bun test` and idempotency holds for free:
 * `oo cargo test` starts with "oo", never with a bare prefix.
 *
 * Injection gate: the rewrite must not fire when the quote-stripped command
 * contains BASH_COMMAND_INJECTION_CHARS anywhere (e.g. `cargo test $(rm x)`)
 * — an in-place rewrite of a command that also runs other things is a
 * broader change than the 12-item contract.
 *
 * The predicate runs on the quote-STRIPPED string (so `pytest 'a && b'`
 * tests clean) but the caller must apply the `oo ` prefix to the ORIGINAL
 * command — stripQuotedSegments returns the executable skeleton, not an
 * in-place-blanked command.
 */
export function ooBarePrefix(command: string): string | undefined {
  const stripped = stripQuotedSegments(command).trim();
  if (BASH_COMMAND_INJECTION_CHARS.test(stripped)) return undefined;
  for (const prefix of OO_PREFIXES) {
    if (stripped === prefix || stripped.startsWith(`${prefix} `)) return prefix;
  }
  return undefined;
}

/**
 * One-time `oo` binary probe. Follows forge-detect.ts's injectable-probe
 * pattern: `probe` replaces the default wholesale so tests stay offline.
 *
 * Synchronous by design: registration is synchronous in this codebase
 * (every register*Guard is a plain function — see issue-creation-guard.ts),
 * and an async registration would defer handler installation to a later
 * microtask, which would silently miss tool calls made before the probe
 * resolves. A synchronous probe keeps registration deterministic.
 *
 * Fail-open to INERT: a spawn error, a non-zero exit, or empty output all
 * mean "treat as absent" — the only safe direction, because an inert hook
 * degrades to today's behaviour, whereas a false-positive "oo found" on a
 * broken host would rewrite every bare command into a command that then
 * fails at execution time. We shell out directly via a minimal synchronous
 * `which oo` (no shell chaining, no `command -v`).
 */
function defaultProbe(): boolean {
  try {
    execFileSync("which", ["oo"], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface OoRewriteGuardOpts {
  /**
   * Injected oo-binary probe; `undefined` uses the default (a one-shot
   * `which oo` via execFileSync). Synchronous so registration stays
   * deterministic (see defaultProbe docstring).
   */
  probe?: () => boolean;
}

let ooBinaryPresent: boolean | undefined;

/**
 * Whether `oo` was found at registration time. Once resolved, the answer is
 * cached for the whole session — no per-call re-probing. `resetOoBinaryCache()`
 * (used by tests) clears the cache. Read by the smoke test to assert the
 * probe ran exactly once.
 */
export function ooBinaryAvailable(): boolean | undefined {
  return ooBinaryPresent;
}

export function resetOoBinaryCache(): void {
  ooBinaryPresent = undefined;
}

/** Whether this subagent's role is in scope (developer or ops only). */
function isRewriteRole(): boolean {
  const role = process.env.PI_ENSEMBLE_ROLE;
  return role === "developer" || role === "ops";
}

export function registerOoRewriteGuard(pi: ExtensionAPI, opts: OoRewriteGuardOpts = {}): void {
  // Probe the `oo` binary ONCE, at registration. Absent → the hook is inert
  // for the whole session (no rewrite, no per-call warning, no re-probe);
  // a single debug-gated trace line explains why.
  const present = (opts.probe ?? defaultProbe)();
  ooBinaryPresent = present;
  if (!present) {
    trace(
      "oo-rewrite-guard: `oo` binary not found at registration — hook inert for this session, bare commands execute as usual",
    );
    return;
  }
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    // Mode split: fire only when the legacy subagent guard's own
    // short-circuits (sandbox or trust) would fire. Strict/headless
    // children (neither marker set — see module header) stay
    // byte-identical to today: no matching, no mutation, and the
    // agents.json deny rows for bare verbose runners are reached exactly
    // as they are now.
    if (
      process.env.PI_ENSEMBLE_SANDBOX_MODE !== "1" &&
      process.env.PI_ENSEMBLE_TRUST_MODE !== "1"
    ) {
      return;
    }
    // Role scope: developer + ops only — the roles whose doctrine
    // prescribes mandatory oo. Read in the body so every other role (and
    // the parent) is untouched.
    if (!isRewriteRole()) return;
    const input = event.input as { command?: string };
    const command = input?.command ?? "";
    const prefix = ooBarePrefix(command);
    if (!prefix) return;
    // Rewrite in place on the ORIGINAL command (the predicate ran on the
    // quote-stripped form). Silent: no block, no message — later handlers
    // see the oo-prefixed string.
    trace(`oo-rewrite-guard: rewriting \`${command}\` → \`oo ${command}\``);
    input.command = `oo ${command}`;
    return;
  });
}
