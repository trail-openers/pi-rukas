/**
 * Sandbox FS guard — symlink-traversal mitigation for `pi-ensemble` sandbox mode.
 *
 * Background: even Anthropic's reference devcontainer for Claude Code shipped a
 * symlink-traversal escape (CVE-2026-39861, fixed in 2.1.64). The pattern: a
 * sandboxed agent creates a symlink inside the bind-mounted workspace that
 * points OUTSIDE it (e.g. `/workspace/escape -> /etc`), then reads/writes
 * through that symlink. The container's filesystem isolation doesn't catch
 * this because the symlink is resolved on the host side of the bind mount.
 *
 * Mitigation: when PI_ENSEMBLE_SANDBOX_MODE=1, intercept every tool_call that
 * carries a filesystem path argument and refuse paths that — after
 * `realpath`-canonicalisation — fall outside the workspace root. The
 * permission-guard short-circuits in sandbox mode, so THIS interceptor is the
 * only layer in front of disk I/O. Keep it tight.
 *
 * Heuristic: scan a small set of argument names commonly used for paths
 * (`path`, `file_path`, `cwd`, `dir`, `target`) plus any string that begins
 * with `/` and resolves to outside `/workspace`. Reject with a clear reason
 * the model can react to.
 *
 * Not in scope: bash command parsing. Bash is intentionally open in sandbox
 * mode — the model can `cat /etc/passwd` directly via bash if it wants, and
 * the container's standard filesystem permissions handle that (vscode user
 * has read on /etc/passwd, no write). The guard only catches the bind-mount
 * escape via symlinks created INSIDE /workspace.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.js";

// Sandbox workspace root inside the container. Bind-mounted by the wrapper /
// devcontainer.json. Anything outside this is off-limits to filesystem
// arguments after canonicalisation.
const WORKSPACE_ROOT = "/workspace";

// Tool argument names that conventionally carry filesystem paths.
const PATH_ARG_KEYS = new Set(["path", "file_path", "cwd", "dir", "target", "filepath"]);

// Tool names that don't take filesystem arguments and can skip the check
// entirely (saves a string scan per call). Add to this set if a tool is
// guaranteed not to read/write the FS via its arguments.
const FS_AGNOSTIC_TOOLS = new Set([
  "websearch",
  "webfetch",
  "vipune",
  "dispatch_specialist",
  "dispatch_parallel",
  "dispatch_status",
  "dispatch_peek",
  "dispatch_steer",
  "dispatch_kill",
  "dispatch_lens_review",
  "adversarial_loop",
  "check_review_cap",
]);

function isInsideWorkspace(candidate: string): boolean {
  // Canonicalise: resolve symlinks. If the symlink target leaves /workspace,
  // realpath surfaces that on its own.
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    // File doesn't exist yet (common for write tools). Fall back to a
    // resolve-relative-to-parent check so a write to /workspace/new-file
    // doesn't get blocked just because new-file doesn't exist yet.
    try {
      const parent = path.dirname(candidate);
      const parentReal = realpathSync(parent);
      resolved = path.join(parentReal, path.basename(candidate));
    } catch {
      // Parent doesn't exist either — let the tool itself handle it.
      // Permit; the tool will fail with ENOENT and the LLM will react.
      return true;
    }
  }
  // Permit anything under WORKSPACE_ROOT (with a separator boundary so
  // /workspace2 isn't accidentally treated as /workspace).
  return resolved === WORKSPACE_ROOT || resolved.startsWith(`${WORKSPACE_ROOT}/`);
}

export function checkSandboxFsArgs(
  toolName: string,
  input: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (FS_AGNOSTIC_TOOLS.has(toolName)) return { ok: true };
  if (!input || typeof input !== "object") return { ok: true };

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (!PATH_ARG_KEYS.has(key)) continue;
    // Skip relative paths — they resolve to /workspace via the cwd.
    if (!value.startsWith("/")) continue;
    if (!isInsideWorkspace(value)) {
      return {
        ok: false,
        reason: `Path '${value}' resolves outside the sandbox workspace (/workspace). The sandbox-fs-guard refuses out-of-workspace filesystem access via tool arguments — use a relative path or reference a file under /workspace.`,
      };
    }
  }
  return { ok: true };
}

export function registerSandboxFsGuard(pi: ExtensionAPI): void {
  if (process.env.PI_ENSEMBLE_SANDBOX_MODE !== "1") return;
  trace("sandbox-fs-guard: registered (workspace=/workspace)");
  pi.on("tool_call", (event) => {
    const verdict = checkSandboxFsArgs(event.toolName, event.input);
    if (!verdict.ok) {
      trace(`sandbox-fs-guard: BLOCKED ${event.toolName} — ${verdict.reason}`);
      return { block: true, reason: verdict.reason };
    }
    return undefined;
  });
}
