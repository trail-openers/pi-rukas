import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdversarialTool } from "./adversarial.ts";
import { registerAsyncJobsLifecycle } from "./async-jobs.ts";
import { registerCommands } from "./commands.ts";
import { registerDispatchStatusTool } from "./dispatch-status.ts";
import { registerDispatchTools } from "./dispatch.ts";
import { registerLensReviewTool } from "./lens-review.ts";
import { loadOverrides } from "./model-config.ts";
import { registerModelPicker } from "./model-picker.ts";
import { registerPairWatchTool } from "./pair-watch.ts";
import { pruneOldRuns, registerRunsCommand } from "./runs.ts";
import { trace } from "./trace.ts";

export default async function (pi: ExtensionAPI) {
  trace("extension activated");
  // Load persisted model overrides BEFORE any spawn can ask for a model.
  await loadOverrides();
  registerDispatchTools(pi);
  registerDispatchStatusTool(pi);
  registerAdversarialTool(pi);
  registerLensReviewTool(pi);
  registerPairWatchTool(pi);
  registerCommands(pi);
  registerRunsCommand(pi);
  registerModelPicker(pi);
  registerAsyncJobsLifecycle(pi);

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
