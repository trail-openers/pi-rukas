import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdversarialTool } from "./adversarial.ts";
import { registerCommands } from "./commands.ts";
import { registerDispatchTools } from "./dispatch.ts";
import { registerLensReviewTool } from "./lens-review.ts";
import { loadOverrides } from "./model-config.ts";
import { registerModelPicker } from "./model-picker.ts";
import { registerRunsCommand } from "./runs.ts";
import { trace } from "./trace.ts";

export default async function (pi: ExtensionAPI) {
  trace("extension activated");
  // Load persisted model overrides BEFORE any spawn can ask for a model.
  await loadOverrides();
  registerDispatchTools(pi);
  registerAdversarialTool(pi);
  registerLensReviewTool(pi);
  registerCommands(pi);
  registerRunsCommand(pi);
  registerModelPicker(pi);
}
