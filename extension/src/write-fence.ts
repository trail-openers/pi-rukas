/**
 * write-fence — the `tool_call` hook that keeps a /work developer child's writes
 * inside its worktree, at write time (#1655).
 *
 * Until now a developer's stray write to the repo root was discovered only at
 * consolidation, as a dirty root (issue #353's cycle parked that way). This
 * refuses the write when the child makes it: the tool returns an error naming the
 * path and the write root, and the child can correct itself. A refusal does not
 * park the cycle; the driver only counts it.
 *
 * Registered from the child-guards companion, which every child loads in every
 * mode, so trust mode and PI_ENSEMBLE_SUBAGENT_MODE=1 both carry it. It is
 * active only when the driver set PI_ENSEMBLE_WRITE_ROOT for the dispatch; a
 * child without one is untouched.
 *
 * Codemode needs no hook of its own. A script's `tools.write` runs through the
 * session's tool pipeline with its own `tool_call` event (carrying
 * `parentToolCallId`): Pi's nested-call runner (`ctx.executeTool`, core/
 * nested-tool-calls.js and agent-session.js `_executeNestedToolCall`) calls the
 * same `_beforeToolCall` as a model-issued call. Verified against the pinned Pi
 * shape; test-write-fence-hook.ts drives it through the hook.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";
import { bashWriteTargets } from "./write-fence-bash.ts";
import { depWriteRefusal, isReadOnlyRole } from "./write-fence-deps.ts";
import { appendWriteFenceRefusal } from "./write-fence-log.ts";
import {
  type FenceConfig,
  expandHome,
  judgeWrite,
  loadFenceConfig,
  refusalText,
  safeResolve,
} from "./write-fence-path.ts";

/** The write tools whose `path` argument is the file they write. */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit"]);

/**
 * The path Pi's write tools actually open: a leading `@` is stripped and `~` /
 * `~/` expand to the home directory (Pi's expandPath). The fence must judge
 * this value, not the raw argument, or `~/x` and `@../../x` pass as in-tree names.
 */
export function piExpandPath(p: string): string {
  return expandHome(p.startsWith("@") ? p.slice(1) : p);
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
    if (typeof args.command !== "string") return notJudged(toolName, "the command is not text");
    for (const t of bashWriteTargets(args.command, cwd)) {
      if (t.opaque !== undefined) {
        return { tool: "bash", path: t.path, message: refusalText(t.path, t.opaque) };
      }
      const judged = judgeWrite(t.path, t.cwd, cfg, {
        linkedCommand: t.linkedCommand,
        throughLinks: t.throughLinks,
      });
      if (!judged.ok) return { tool: "bash", path: t.path, message: judged.message };
    }
    return undefined;
  }
  if (WRITE_TOOLS.has(toolName)) {
    if (typeof args.path !== "string") return notJudged(toolName, "the path is not text");
    const judged = judgeWrite(piExpandPath(args.path), cwd, cfg);
    if (!judged.ok) return { tool: toolName, path: args.path, message: judged.message };
  }
  return undefined;
}

/** A call whose arguments are not the shape the fence reads: it is refused, not waved through. */
function notJudged(toolName: string, why: string): Refusal {
  const path = `(${toolName} call)`;
  return { tool: toolName, path, message: refusalText(path, `it could not be judged: ${why}`) };
}

/**
 * #1879 — the read-only-role dependency rule, expressed as a refusal. Only
 * bash is judged: the write/edit/multiedit tools are already structurally
 * excluded for these roles by role-tools.ts, and if that ever leaks, the
 * whole-tree fence catches their writes anyway.
 */
function depsRefusalFor(input: unknown, role: string | undefined): Refusal | undefined {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  if (typeof args.command !== "string") return undefined;
  const reason = depWriteRefusal(
    role,
    bashWriteTargets(args.command, process.cwd()),
    // The OS rule, so a provisioned link into the main checkout's tree resolves
    // to the tree it really writes — the exact shape of the #1879 incident.
    safeResolve,
  );
  return reason === undefined
    ? undefined
    : { tool: "bash", path: "(dependency write)", message: reason };
}

/**
 * Register the fence for this child. A no-op unless the dispatch set
 * `PI_ENSEMBLE_WRITE_ROOT` (the whole-tree fence) or the child is one of the
 * read-only roles the dependency rule covers — see the two gates below.
 */
export function registerWriteFence(pi: ExtensionAPI): void {
  // The two rules are INDEPENDENT gates and each reads its own switch.
  //
  //   - the whole-tree fence: the developer's fence, which the operator's
  //     `PI_ENSEMBLE_WRITE_FENCE=0` escape hatch exists to switch off (it is
  //     also inert when the dispatch set no `PI_ENSEMBLE_WRITE_ROOT`).
  //   - the dependency-tree rule for read-only roles: NOT switchable by that
  //     hatch. The hatch is documented for the developer whole-tree fence; a
  //     reviewer has no write root at all, so the hatch was never its gate, and
  //     one env var that silently disarmed the shared-toolchain rule would
  //     reopen #1879 with the escape hatch as the vector.
  const cfg = loadFenceConfig(process.env);
  const wholeTree = cfg !== undefined;
  const readOnlyRole = process.env.PI_ENSEMBLE_ROLE;
  const depRule = isReadOnlyRole(readOnlyRole);
  if (!wholeTree && !depRule) return;
  const scratch = process.env.PI_ENSEMBLE_WRITE_SCRATCH;
  const repo = process.env.PI_ENSEMBLE_WRITE_REPO;
  pi.on("tool_call", async (event) => {
    let refusal: Refusal | undefined;
    try {
      refusal = wholeTree ? refusalFor(event.toolName, event.input, cfg) : undefined;
      if (refusal === undefined && event.toolName === "bash") {
        refusal = depsRefusalFor(event.input, readOnlyRole);
      }
    } catch (err) {
      // An internal fault is a refusal too: the call is not judged, so it does not run.
      const reason = `write fence could not judge this call: ${(err as Error).message}`;
      trace(`write-fence: ${reason}`);
      appendWriteFenceRefusal(
        scratch,
        { tool: event.toolName, path: "(not judged)", reason, at: Date.now() },
        repo,
      );
      return { block: true, reason };
    }
    if (!refusal) return;
    trace(`write-fence: refused ${refusal.tool} to ${refusal.path}`);
    appendWriteFenceRefusal(
      scratch,
      { tool: refusal.tool, path: refusal.path, reason: refusal.message, at: Date.now() },
      repo,
    );
    return { block: true, reason: refusal.message };
  });
}
