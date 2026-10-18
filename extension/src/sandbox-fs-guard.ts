/**
 * Sandbox FS guard — symlink-traversal mitigation for `pi-rukas` sandbox mode.
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

// Sandbox workspace root inside the container — the primary in-bounds dir.
//
// Read from PI_ENSEMBLE_WORKSPACE_ROOT env, set by bin/pi-rukas wrapper
// to the project's host absolute path (e.g. /Users/dev/projects/lantern)
// so Pi's session-bucket scoping matches host mode (#207). Falls back to
// `/workspace` for users running the image directly via `docker run`
// without the wrapper, or via VS Code devcontainer.json (which still mounts
// at /workspace by spec).
//
// Read on every call (not module-level const) so tests can mutate the env
// between assertions and so a runtime env change is honored.
function getWorkspaceRoot(): string {
  return process.env.PI_ENSEMBLE_WORKSPACE_ROOT ?? "/workspace";
}

// Additional allowed roots — colon-separated list (PATH-like) of absolute
// directories that should be treated as in-bounds in addition to the
// workspace root. Wrapper populates this with the image-drag-and-drop dirs
// ($HOME/Downloads, /Desktop, /Pictures) bind-mounted RO so paths pasted
// by the terminal resolve inside the container AND the guard permits the
// read. Empty / unset → only the workspace root is allowed (status quo).
function getAllowedRoots(): string[] {
  const raw = process.env.PI_ENSEMBLE_ALLOWED_ROOTS;
  if (!raw) return [];
  return raw.split(":").filter((p) => p.length > 0);
}

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
  "start_review_cap",
]);

function isInsideWorkspace(candidate: string): boolean {
  // Canonicalise: resolve symlinks. If the symlink target leaves the
  // allowed area, realpath surfaces that on its own.
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    // File doesn't exist yet (common for write tools). Fall back to a
    // resolve-relative-to-parent check so a write to <workspace>/new-file
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
  // Permit anything under the workspace root OR any additional allowed
  // root (separator boundary so /workspace2 isn't accidentally treated as
  // /workspace, and /Users/dev/DownloadsX isn't treated as inside
  // /Users/dev/Downloads).
  const roots = [getWorkspaceRoot(), ...getAllowedRoots()];
  for (const root of roots) {
    // Resolve symlinks on the root too — macOS-style `/tmp` → `/private/tmp`
    // would otherwise defeat the prefix-match for paths the user thinks
    // are inside.
    let rootResolved: string;
    try {
      rootResolved = realpathSync(root);
    } catch {
      // Root doesn't exist on disk — skip (can't be inside a non-existent dir).
      continue;
    }
    if (resolved === rootResolved || resolved.startsWith(`${rootResolved}/`)) {
      return true;
    }
  }
  return false;
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
      const workspaceRoot = getWorkspaceRoot();
      const extras = getAllowedRoots();
      const allowed =
        extras.length > 0 ? `${workspaceRoot} (or any of: ${extras.join(", ")})` : workspaceRoot;
      return {
        ok: false,
        reason: `Path '${value}' resolves outside the sandbox workspace. The sandbox-fs-guard permits paths under ${allowed}. For images outside these roots, either drop them into the project first OR set PI_ENSEMBLE_EXTRA_IMAGE_DIRS to include their parent directory before launching pi-rukas.`,
      };
    }
  }
  return { ok: true };
}

export function registerSandboxFsGuard(pi: ExtensionAPI): void {
  if (process.env.PI_ENSEMBLE_SANDBOX_MODE !== "1") return;
  trace(`sandbox-fs-guard: registered (workspace=${getWorkspaceRoot()})`);
  pi.on("tool_call", (event) => {
    const verdict = checkSandboxFsArgs(event.toolName, event.input);
    if (!verdict.ok) {
      trace(`sandbox-fs-guard: BLOCKED ${event.toolName} — ${verdict.reason}`);
      return { block: true, reason: verdict.reason };
    }
    return undefined;
  });
}
