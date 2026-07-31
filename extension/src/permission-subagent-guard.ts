/**
 * Subagent-mode permission guard. Runs INSIDE spawned Pi subagents (when
 * PI_ENSEMBLE_SUBAGENT_MODE=1 + pi-ensemble forwarded via --extension by
 * spawn.ts). Same 3-tier resolution as the parent guard, but `ask` verdicts
 * escalate to the parent over a Unix socket (PI_ENSEMBLE_PERM_SOCKET) instead
 * of prompting locally (subagents have no UI). Split out of
 * permission-guard.ts (#171) to stay under the module-size guideline
 * (AGENTS.md §12) — registerPermissionGuard is the sole caller.
 *
 * Recursion firewall: spawn.ts + index.ts together ensure subagent-mode
 * pi-ensemble registers ONLY this guard — no dispatch tools, no slash
 * commands. So a subagent's permission decisions can't trigger further
 * subagent spawns.
 */

import { type Socket, createConnection } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionRequest } from "./permission-broker.ts";
import { loadAgentsJson, loadGlobalConfig, loadProjectConfig } from "./permission-config.ts";
import { resolveToolPermission } from "./permission-guard.ts";
import { trace } from "./trace.ts";

export function registerSubagentGuard(pi: ExtensionAPI): void {
  // Sandbox mode short-circuit (PR #197). When pi-ensemble runs inside the
  // Docker sandbox (`pi-ensemble` wrapper sets PI_ENSEMBLE_SANDBOX_MODE=1),
  // the container fence IS the trust boundary. Every tool call passes
  // through with no per-call gating, no socket broker, no overlay loading.
  // This is the structural fix for the prompt-flood UX problem: the user
  // moves into a sandboxed container instead of rubber-stamping prompts
  // they no longer read. See bin/pi-ensemble + .devcontainer/.
  if (process.env.PI_ENSEMBLE_SANDBOX_MODE === "1") {
    trace("subagent-guard: PI_ENSEMBLE_SANDBOX_MODE=1 — bypassing all tool gating");
    return;
  }
  // Trust mode propagated from parent (interactive host without strict opt-in).
  // Parent set PI_ENSEMBLE_TRUST_MODE=1 in our env via spawn.ts — same effect
  // as sandbox: no per-call gating, no socket broker. See isInTrustMode in
  // permission-guard.ts for the full rationale.
  if (process.env.PI_ENSEMBLE_TRUST_MODE === "1") {
    trace("subagent-guard: PI_ENSEMBLE_TRUST_MODE=1 — bypassing all tool gating");
    return;
  }
  const role = process.env.PI_ENSEMBLE_ROLE;
  const socketPath = process.env.PI_ENSEMBLE_PERM_SOCKET;
  if (!role) {
    trace("subagent-guard: PI_ENSEMBLE_ROLE unset — guard inactive, role unknown");
    return;
  }
  trace(
    `subagent-guard: registering for role '${role}' · socket=${socketPath ?? "<unset, will headless-deny on ask>"}`,
  );
  const agentsConfig = loadAgentsJson();
  // Subagents DO read project + global permission overlays — the user edits
  // these precisely to override the agents.json baseline (e.g. granting a
  // role a project-specific MCP tool the baseline withholds). Pre-#192 the
  // subagent guard stubbed both overlays to `{}` with the now-disproven
  // rationale "those reflect the user's local layered config and don't
  // belong to the subagent's process context" — that broke users who put
  // `mcp*: allow` for developer in `.pi/permissions.json` and saw their
  // grant silently ignored by every dispatched developer subagent.
  // findProjectConfigPath walks up from cwd so worktree subagents resolve
  // the repo-root overlay correctly.
  const projectConfig = loadProjectConfig();
  const globalConfig = loadGlobalConfig();

  let socket: Socket | null = null;
  let socketBuffer = "";
  let pendingResolvers: Array<(verdict: { allowed: boolean; reason?: string }) => void> = [];

  function ensureSocket(): Socket | null {
    if (!socketPath) return null;
    if (socket && !socket.destroyed) return socket;
    try {
      socket = createConnection(socketPath);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string | Buffer) => {
        socketBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let nl = socketBuffer.indexOf("\n");
        while (nl >= 0) {
          const line = socketBuffer.slice(0, nl);
          socketBuffer = socketBuffer.slice(nl + 1);
          nl = socketBuffer.indexOf("\n");
          try {
            const v = JSON.parse(line) as {
              type?: string;
              allowed?: boolean;
              reason?: string;
            };
            if (v.type === "permission-verdict" && typeof v.allowed === "boolean") {
              const resolve = pendingResolvers.shift();
              if (resolve) resolve({ allowed: v.allowed, reason: v.reason });
            }
          } catch (err) {
            trace(`subagent-guard: malformed verdict line: ${(err as Error).message}`);
          }
        }
      });
      socket.on("error", (err) => {
        trace(`subagent-guard: socket error: ${err.message}`);
        socket = null;
      });
      socket.on("close", () => {
        socket = null;
        // Resolve any pending requests as deny so the subagent doesn't hang.
        const resolvers = pendingResolvers;
        pendingResolvers = [];
        for (const r of resolvers) r({ allowed: false, reason: "broker socket closed" });
      });
      return socket;
    } catch (err) {
      trace(`subagent-guard: connect to ${socketPath} failed: ${(err as Error).message}`);
      return null;
    }
  }

  async function escalateAsk(
    toolName: string,
    bashCommand: string | undefined,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const sock = ensureSocket();
    if (!sock) {
      return { allowed: false, reason: "no broker socket — headless deny" };
    }
    const req: PermissionRequest = {
      type: "permission-request",
      role: role ?? "unknown",
      toolName,
      bashCommand,
    };
    return new Promise((resolve) => {
      pendingResolvers.push(resolve);
      try {
        sock.write(`${JSON.stringify(req)}\n`);
      } catch (err) {
        // Remove our resolver, return deny.
        const idx = pendingResolvers.indexOf(resolve);
        if (idx >= 0) pendingResolvers.splice(idx, 1);
        resolve({ allowed: false, reason: `socket write failed: ${(err as Error).message}` });
      }
    });
  }

  pi.on("tool_call", async (event, _ctx) => {
    try {
      const command =
        event.toolName === "bash" ? ((event.input as { command?: string })?.command ?? "") : "";
      const verdict = resolveToolPermission(
        event.toolName,
        role,
        projectConfig,
        globalConfig,
        agentsConfig,
        event.toolName === "bash" ? command : undefined,
      );
      if (verdict === "allow") return;
      if (verdict === "deny") {
        trace(`subagent-guard: BLOCKED ${event.toolName} for role=${role} (verdict=deny)`);
        return {
          block: true,
          reason: `Tool '${event.toolName}' is not permitted for role '${role}' (subagent)`,
        };
      }
      // verdict === "ask" — escalate to parent over socket.
      const result = await escalateAsk(
        event.toolName,
        event.toolName === "bash" ? command : undefined,
      );
      if (result.allowed) return;
      return {
        block: true,
        reason: `Tool '${event.toolName}' denied (subagent ask → ${result.reason ?? "denied"})`,
      };
    } catch (err) {
      trace(`subagent-guard: internal error: ${(err as Error).message}`);
      return { block: true, reason: "subagent guard internal error" };
    }
  });
}
