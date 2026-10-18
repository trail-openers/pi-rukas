/**
 * write-fence — the `tool_call` hook that keeps a /work developer child's writes
 * inside its worktree, at write time (#1655).
 *
 * Until now a developer's stray write to the repo root was discovered only at
 * consolidation, as a dirty root, after the whole develop spend (issue #353's
 * cycle parked that way). This refuses the write when the child makes it: the
 * tool returns an error naming the path and the write root, and the child can
 * correct itself. A refusal does not park the cycle; the driver only counts it.
 *
 * Registered from the child-guards companion, which every child loads in every
 * mode, so trust mode and PI_ENSEMBLE_SUBAGENT_MODE=1 both carry it. It is
 * active only when the driver set PI_ENSEMBLE_WRITE_ROOT for the dispatch; a
 * child without one is untouched.
 *
 * Codemode needs no hook of its own. A script's `tools.write` runs through the
 * session's tool pipeline with its own `tool_call` event (carrying
 * `parentToolCallId`), so this hook sees it like any other write.
 */

import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";
import { bashWriteTargets } from "./write-fence-bash.ts";
import { appendWriteFenceRefusal } from "./write-fence-log.ts";
import { type FenceConfig, judgeWrite, loadFenceConfig } from "./write-fence-path.ts";

/** The write tools whose `path` argument is the file they write. */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit"]);

/**
 * The path Pi's write tools actually open: a leading `@` is stripped and `~` /
 * `~/` expand to the home directory (Pi's expandPath). The fence must judge
 * this value, not the raw argument, or `~/x` and `@../../x` pass as in-tree names.
 */
export function piExpandPath(p: string): string {
  const stripped = p.startsWith("@") ? p.slice(1) : p;
  return stripped === "~" || stripped.startsWith("~/")
    ? os.homedir() + stripped.slice(1)
    : stripped;
}

interface Refusal {
  tool: string;
  path: string;
  message: string;
}

/** The first write in this call that falls outside the fence, if any. */
function refusalFor(toolName: string, input: unknown, cfg: FenceConfig): Refusal | undefined {
  // `input` is the tool's raw argument object; its shape is checked before use.
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const cwd = process.cwd();
  if (toolName === "bash") {
    if (typeof args.command !== "string") return undefined;
    for (const t of bashWriteTargets(args.command, cwd)) {
      if (t.opaque) {
        return {
          tool: "bash",
          path: t.path,
          message: `Refused: ${t.path} — it uses brace expansion, which the fence does not expand. Name each path literally.`,
        };
      }
      const judged = judgeWrite(t.path, t.cwd, cfg, {
        linkedCommand: t.linkedCommand,
      });
      if (!judged.ok) return { tool: "bash", path: t.path, message: judged.message };
    }
    return undefined;
  }
  if (WRITE_TOOLS.has(toolName) && typeof args.path === "string") {
    const judged = judgeWrite(piExpandPath(args.path), cwd, cfg);
    if (!judged.ok) return { tool: toolName, path: args.path, message: judged.message };
  }
  return undefined;
}

/** Register the fence for this child. A no-op unless the dispatch set PI_ENSEMBLE_WRITE_ROOT. */
export function registerWriteFence(pi: ExtensionAPI): void {
  const cfg = loadFenceConfig(process.env);
  if (!cfg) return;
  const scratch = process.env.PI_ENSEMBLE_WRITE_SCRATCH;
  pi.on("tool_call", async (event) => {
    const refusal = refusalFor(event.toolName, event.input, cfg);
    if (!refusal) return;
    trace(`write-fence: refused ${refusal.tool} to ${refusal.path}`);
    appendWriteFenceRefusal(scratch, {
      tool: refusal.tool,
      path: refusal.path,
      reason: refusal.message,
      at: Date.now(),
    });
    return { block: true, reason: refusal.message };
  });
}
