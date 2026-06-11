/**
 * Permission broker — parent-side socket server that handles `ask` verdicts
 * escalated from subagent pi-ensemble guards.
 *
 * Architecture (the "subagent permission" feature):
 *
 *   parent Pi process                  subagent Pi process
 *   ─────────────────                   ────────────────────
 *   pi-ensemble (parent mode)          pi-ensemble (subagent mode,
 *     - permission-guard                 PI_ENSEMBLE_SUBAGENT_MODE=1)
 *     - permission-broker (this file)    - permission-guard only
 *     - everything else
 *
 *   spawn.ts creates a per-spawn Unix socket at
 *   /tmp/pi-ensemble-perm-<runId>.sock; passes the path via the
 *   PI_ENSEMBLE_PERM_SOCKET env var; starts a broker that listens on it.
 *
 *   Subagent guard on `ask` verdict:
 *     1. Connect to PI_ENSEMBLE_PERM_SOCKET (cached after first connect)
 *     2. Write `{ type: "permission-request", role, toolName, bashCommand?, jobId? }\n`
 *     3. Await `{ type: "permission-verdict", allowed: boolean, scope: "once"|"always" }`
 *     4. Apply verdict
 *
 *   Broker on each request:
 *     1. Check decisions cache (cachedLookup callback) — if cached, respond now
 *     2. Else prompt the user via ctx.ui.select (Allow once / Allow always / Deny once / Deny always)
 *     3. On `always`, persist via persistDecision callback
 *     4. Respond on the socket
 *
 *   Cleanup is per-spawn: spawn.ts calls `broker.stop()` in its finally block;
 *   the broker closes the server, unlinks the socket file, and frees resources.
 *
 * Headless safety: if ctx.hasUI is false (e.g. `pi -p`), every ask becomes
 * deny — no prompt blocking, no UI calls. Same behaviour as the parent guard.
 */

import { unlinkSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { trace } from "./trace.ts";

export interface PermissionRequest {
  type: "permission-request";
  role: string;
  toolName: string;
  /** Present only when toolName === "bash"; the raw command being requested. */
  bashCommand?: string;
  /** For provenance / tracing only; not used for verdict resolution. */
  jobId?: string;
}

export interface PermissionVerdict {
  type: "permission-verdict";
  allowed: boolean;
  /** Scope of the user's decision. Cached by broker when "always". */
  scope: "once" | "always";
  /** Optional reason — populated for deny verdicts to surface in subagent reports. */
  reason?: string;
}

/**
 * Broker dependencies — the parent's pi-ensemble extension injects these.
 * `cachedLookup` and `persistDecision` reuse the existing decisions Map +
 * persistDecisions write-through from permission-guard.ts so the cache is
 * shared between parent prompts and subagent prompts.
 */
export interface BrokerDeps {
  /** Return cached verdict if any. undefined → not cached. */
  cachedLookup(req: PermissionRequest): boolean | undefined;
  /** Persist user's decision to the in-memory + on-disk decisions cache. */
  persistDecision(req: PermissionRequest, allowed: boolean): void;
  /**
   * Prompt the user. Resolves with `{allowed, scope}` for "Allow once / always
   * / Deny once / always", or rejects on UI error / cancellation. Headless
   * mode (no UI) → reject so the broker can return deny cleanly.
   */
  promptUser(req: PermissionRequest): Promise<{ allowed: boolean; scope: "once" | "always" }>;
}

export interface BrokerHandle {
  /** Close the server and unlink the socket file. Idempotent. */
  stop(): void;
}

/**
 * Start a broker listening on the given socket path. Returns a handle whose
 * `stop()` tears down the server + socket file. Callers (spawn.ts) should
 * call stop() in a finally block.
 */
export function startBroker(socketPath: string, deps: BrokerDeps): BrokerHandle {
  let stopped = false;
  const server: Server = createServer((conn) => {
    // Subagent connects, sends one JSON-line request, awaits one response.
    // Multiple requests per connection are supported via newline framing.
    let buffer = "";
    conn.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let nl: number = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        await handleLine(line, conn, deps);
      }
    });
    conn.on("error", (err) => {
      trace(`permission-broker: connection error: ${err.message}`);
    });
  });
  server.on("error", (err) => {
    trace(`permission-broker: server error on ${socketPath}: ${err.message}`);
  });
  server.listen(socketPath, () => {
    trace(`permission-broker: listening on ${socketPath}`);
  });
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        server.close();
      } catch {
        // Server already closed — fine.
      }
      try {
        unlinkSync(socketPath);
      } catch {
        // Socket already unlinked — fine.
      }
      trace(`permission-broker: stopped, socket ${socketPath} unlinked`);
    },
  };
}

/**
 * Per-line request handler. Parses JSON, consults the cache, prompts the
 * user if necessary, writes the verdict back as one JSON line. Errors are
 * mapped to deny verdicts with descriptive reasons — never throws back to
 * the subagent (would leave it hanging).
 */
async function handleLine(
  line: string,
  conn: { write(data: string): boolean },
  deps: BrokerDeps,
): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let req: PermissionRequest;
  try {
    req = JSON.parse(trimmed) as PermissionRequest;
  } catch (err) {
    writeVerdict(conn, {
      type: "permission-verdict",
      allowed: false,
      scope: "once",
      reason: `malformed request: ${(err as Error).message}`,
    });
    return;
  }
  if (req.type !== "permission-request" || typeof req.toolName !== "string") {
    writeVerdict(conn, {
      type: "permission-verdict",
      allowed: false,
      scope: "once",
      reason: "invalid request shape",
    });
    return;
  }
  // 1. Cache lookup — short-circuit if we have a prior decision.
  const cached = deps.cachedLookup(req);
  if (cached !== undefined) {
    writeVerdict(conn, {
      type: "permission-verdict",
      allowed: cached,
      scope: "always",
      reason: cached ? undefined : "denied by prior cached decision",
    });
    return;
  }
  // 2. Prompt the user.
  try {
    const { allowed, scope } = await deps.promptUser(req);
    if (scope === "always") deps.persistDecision(req, allowed);
    writeVerdict(conn, {
      type: "permission-verdict",
      allowed,
      scope,
      reason: allowed ? undefined : "denied by user",
    });
  } catch (err) {
    // Prompt failed (headless, UI error, cancellation). Default to deny.
    writeVerdict(conn, {
      type: "permission-verdict",
      allowed: false,
      scope: "once",
      reason: `prompt failed: ${(err as Error).message}`,
    });
  }
}

function writeVerdict(conn: { write(data: string): boolean }, verdict: PermissionVerdict): void {
  try {
    conn.write(`${JSON.stringify(verdict)}\n`);
  } catch (err) {
    trace(`permission-broker: writeVerdict failed: ${(err as Error).message}`);
  }
}
