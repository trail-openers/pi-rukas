import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdversarialTool } from "./adversarial.ts";
import { LIST_SHORTCUT } from "./agent-list-keys.ts";
import { openAgentListWithReturn } from "./agent-list-nav.ts";
import { registerAgentsMdTools } from "./agents-md-tool.ts";
import { setParentExtensionApi } from "./async-jobs-registry.ts";
import { registerAsyncJobsLifecycle } from "./async-jobs.ts";
import { registerCommands, stripPmTools } from "./commands.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { registerDispatchPeekTool } from "./dispatch-peek.ts";
import { registerDispatchStatusTool } from "./dispatch-status.ts";
import { registerDispatchSteerTool } from "./dispatch-steer.ts";
import { registerDispatchTools } from "./dispatch.ts";
import { registerLensReviewTool } from "./lens-review-tool.ts";
import * as lifecycle from "./lifecycle-events.ts";
import { loadOverrides } from "./model-config.ts";
import { registerModelPicker } from "./model-picker.ts";
import { registerPermissionGuard } from "./permission-guard.ts";
import { registerPlanTool } from "./plan-tool.ts";
import { setPmActive } from "./pm-active.ts";
import { registerPmModePersistence } from "./pm-mode-persist.ts";
import { registerQuestionTool } from "./question-tool.ts";
import { registerResearchTool } from "./research-tool.ts";
import { warnIfRetryConfigTooLow } from "./retry-config-check.ts";
import { registerCheckReviewCapTool } from "./review-cap.ts";
import { pruneOldRuns, registerRunsCommand } from "./runs.ts";
import { registerSandboxFsGuard } from "./sandbox-fs-guard.ts";
import * as sessionAutosave from "./session-autosave.ts";
import { trace } from "./trace.ts";
import { registerWorkTools } from "./work-tool.ts";
import * as workWidget from "./work-widget.ts";

export default async function (pi: ExtensionAPI) {
  trace("extension activated");
  // Subagent-mode firewall: when pi-rukas is forwarded INTO a spawned
  // subagent (by spawn.ts setting PI_ENSEMBLE_SUBAGENT_MODE=1), register
  // ONLY the permission-guard. No dispatch tools, no slash commands, no
  // model picker, no auto-save — those are parent-orchestrator concerns
  // and registering them in subagents would enable recursive spawning.
  // permission-guard.ts detects the same env var and installs its
  // subagent-mode handler (escalates `ask` to parent over a Unix socket).
  if (process.env.PI_ENSEMBLE_SUBAGENT_MODE === "1") {
    registerPermissionGuard(pi);
    // sandbox-fs-guard self-gates on PI_ENSEMBLE_SANDBOX_MODE; safe to call always.
    // It's the only filesystem fence in sandbox mode (permission-guard short-circuits).
    registerSandboxFsGuard(pi);
    trace("extension: subagent mode — permission-guard + sandbox-fs-guard only");
    return;
  }
  // Load persisted model overrides BEFORE any spawn can ask for a model.
  await loadOverrides();
  // The whole retry story assumes a provider's `retry-after` is honoured. That
  // depends on a setting pi-rukas does not own, so say so when it is not.
  void warnIfRetryConfigTooLow();
  // #987 — the `question` tool the PM prompt and agents.json reference.
  // Parent-only by construction: subagent mode returns above, before any
  // tools are registered.
  registerQuestionTool(pi);
  // A reopened session goes back into PM mode, tools stripped, as it was.
  registerPmModePersistence(pi, () => stripPmTools(pi));
  registerDispatchTools(pi);
  registerDispatchStatusTool(pi);
  registerDispatchPeekTool(pi);
  registerDispatchSteerTool(pi);
  registerCheckReviewCapTool(pi);
  registerAdversarialTool(pi);
  registerLensReviewTool(pi);
  registerCommands(pi);
  // #408 — PM can start the compiled driver instead of hand-rolling it. Must
  // follow registerCommands: the doctrine tool reads the same prompt bodies.
  registerWorkTools(pi);
  // #526 — /agents-md delivery: the core is called in-process, never via a
  // host-relative path. Must follow registerWorkTools: the tool reuses
  // work-entry's resolveRepoRoot.
  registerAgentsMdTools(pi);
  // #598 — issue creation is gated behind the compiled plan driver. The guard
  // (issue-creation-guard.ts) is registered inside registerPermissionGuard
  // below; this is the "thing to call instead" half of that gate.
  registerPlanTool(pi);
  // /research's deterministic spine is compiled (research-driver.ts); the
  // /research prose body now instructs PM to call this tool. Judgement
  // (angle choice, the post-artifact conversation) stays with PM.
  registerResearchTool(pi);
  registerRunsCommand(pi);
  registerModelPicker(pi);
  registerAsyncJobsLifecycle(pi);
  registerPermissionGuard(pi);
  // #799 — the slow-run watch's PM-notice half needs a pi even from code
  // that spawns children without one in scope (lens + adversarial children);
  // this registers the parent api once, before any dispatch can exist.
  setParentExtensionApi(pi);
  // Sandbox FS guard — self-gates on PI_ENSEMBLE_SANDBOX_MODE=1. In sandbox
  // mode the permission-guard short-circuits, so this is the only layer
  // preventing symlink-traversal out of /workspace (CVE-2026-39861 class).
  registerSandboxFsGuard(pi);
  // Lifecycle scrollback (#118) — register renderer + capture pi for sendMessage.
  lifecycle.attach(pi);
  // Session autosave (#23) — writes a structured summary to vipune on
  // session_shutdown when PI_ENSEMBLE_AUTOSAVE=1. Opt-in; no-op otherwise.
  sessionAutosave.attach(pi);

  // #914 — global shortcut for the agent-list overlay (main + every running
  // subagent; Enter → live view, x → kill, the stop-all chord → kill all,
  // Esc → main UI). The handler opens the list with its OWN ctx (the
  // registerShortcut handler receives a fresh ctx per press), and routes
  // Enter-on-job through the deck's confirm route unchanged until #916.
  // Registered even in quiet mode (quiet only suppresses the passive deck
  // widget, #914).
  try {
    pi.registerShortcut(LIST_SHORTCUT, {
      description: "Open agent list",
      // #916 SLICE B — thread the list re-open into the view's Esc route
      // (confirmRow → onRowConfirm → openLiveView → done "returnToList").
      // The roster nav path passes nothing, so Esc there just closes, as
      // before. The shared closure lives in agent-list-nav.ts (one
      // production copy, also called by smoke-tests/test-agent-list-nav.ts).
      handler: (ctx) => {
        return openAgentListWithReturn(ctx);
      },
    });
  } catch (err) {
    trace(`agent-list: shortcut registration failed: ${(err as Error).message}`);
  }
  // Capture an ExtensionContext so the dispatch deck (#117) can call
  // ctx.ui.setStatus from spawn.ts onProgress callbacks that fire outside
  // any event handler scope. Pi passes ctx into every event listener; we
  // hold the reference until session_shutdown.
  pi.on("session_start", (_event, ctx) => {
    dispatchDeck.attach(ctx);
    workWidget.attach(ctx);
  });
  // #916 SLICE B — the "PM active" badge seam: the parent agent's streaming
  // state is exposed on the ExtensionContext (ctx.isIdle), not on the TUI.
  // index.ts flips pm-active.ts from pi's agent_start / agent_end events
  // (the PARENT's own lifecycle — subagent children are separate processes
  // and never fire the parent's events); the live-view header reads
  // pmActive() each render.
  pi.on("agent_start", () => setPmActive(true));
  pi.on("agent_end", () => setPmActive(false));
  pi.on("session_shutdown", () => {
    dispatchDeck.detach();
    workWidget.detach();
    lifecycle.detach();
  });

  // Fire-and-forget housekeeping: age-based retention for subagent transcripts
  // — delete batches whose newest child is older than the window (default 5
  // days, override via PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS; 0 disables).
  // The in-progress safety floor (60 s) protects spawns that are still being
  // written to.
  pruneOldRuns()
    .then((s) => {
      if (s.deletedBatches > 0) {
        trace(
          `pruned ${s.deletedBatches} old batches (${s.deletedFiles} files, ${(s.bytesFreed / 1024).toFixed(1)} KB)`,
        );
      }
      if (s.failedFiles > 0) {
        trace(`prune: ${s.failedFiles} file(s) could not be deleted`);
      }
    })
    .catch((err) => {
      trace(`prune skipped: ${(err as Error).message}`);
    });
}
