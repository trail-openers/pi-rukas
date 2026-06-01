import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdversarialTool } from "./adversarial.ts";
import { registerAsyncJobsLifecycle } from "./async-jobs.ts";
import { registerCommands } from "./commands.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { registerDispatchPeekTool } from "./dispatch-peek.ts";
import { registerDispatchStatusTool } from "./dispatch-status.ts";
import { registerDispatchTools } from "./dispatch.ts";
import { registerLensReviewTool } from "./lens-review.ts";
import * as lifecycle from "./lifecycle-events.ts";
import { loadOverrides } from "./model-config.ts";
import { registerModelPicker } from "./model-picker.ts";
import { registerPermissionGuard } from "./permission-guard.ts";
import { pruneOldRuns, registerRunsCommand } from "./runs.ts";
import { trace } from "./trace.ts";

export default async function (pi: ExtensionAPI) {
  trace("extension activated");
  // Load persisted model overrides BEFORE any spawn can ask for a model.
  await loadOverrides();
  registerDispatchTools(pi);
  registerDispatchStatusTool(pi);
  registerDispatchPeekTool(pi);
  registerAdversarialTool(pi);
  registerLensReviewTool(pi);
  registerCommands(pi);
  registerRunsCommand(pi);
  registerModelPicker(pi);
  registerAsyncJobsLifecycle(pi);
  registerPermissionGuard(pi);
  // Lifecycle scrollback (#118) — register renderer + capture pi for sendMessage.
  lifecycle.attach(pi);

  // Capture an ExtensionContext so the dispatch deck (#117) can call
  // ctx.ui.setStatus from spawn.ts onProgress callbacks that fire outside
  // any event handler scope. Pi passes ctx into every event listener; we
  // hold the reference until session_shutdown.
  pi.on("session_start", (_event, ctx) => {
    dispatchDeck.attach(ctx);
  });
  pi.on("session_shutdown", () => {
    dispatchDeck.detach();
    lifecycle.detach();
  });

  // Fire-and-forget housekeeping: keep the most-recent N subagent transcripts
  // on disk (default 20, override via PI_ENSEMBLE_RUNS_KEEP_LAST). The user's
  // mental model is "the latest or second-latest run" — anything older is
  // noise that bloats the /runs picker. The in-progress safety floor (60 s)
  // protects spawns that are still being written to.
  pruneOldRuns()
    .then((s) => {
      if (s.deletedBatches > 0) {
        trace(
          `pruned ${s.deletedBatches} old batches (${s.deletedFiles} files, ${(s.bytesFreed / 1024).toFixed(1)} KB)`,
        );
      }
    })
    .catch((err) => {
      trace(`prune skipped: ${(err as Error).message}`);
    });
}
