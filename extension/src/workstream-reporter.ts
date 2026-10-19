/**
 * Companion Pi extension loaded into the /work plan child process (#1652).
 *
 * Registers a single `report_workstream` tool. The schema lives in
 * plan-workstream-schema.ts (imported by the driver too); Pi validates each call
 * against it in-process, so a schema-invalid call never reaches `execute`. The
 * parent (work-driver-plan-calls.ts) reads the calls and their results back from
 * the child's session.
 *
 * Two checks need more than the schema, and both live here so the model sees
 * the refusal as a tool error and can correct it in the same dispatch: a
 * duplicate `id` (the set is per process, which is per dispatch — a corrective
 * re-dispatch starts empty, as the plan step's contract requires) and a declared
 * path that is not plain repo-relative. The parent re-judges both.
 *
 * Loaded via `pi --no-extensions --extension <path>` from work-driver-plan.ts;
 * never auto-discovered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  WORKSTREAM_PARAMETERS,
  type WorkstreamArgs,
  workstreamCallRefusal,
} from "./plan-workstream-schema.ts";

export default function (pi: ExtensionAPI) {
  const accepted = new Set<string>();
  pi.registerTool({
    name: "report_workstream",
    label: "Report Workstream",
    description:
      "Report ONE workstream of the plan. Call once per workstream — do not batch, and do not write a workstreams section in your reply: only these calls count. A call whose `id` repeats an earlier call in this reply is refused with an error naming the duplicate; give that workstream a distinct id and call again. Every workstream MUST declare a non-empty `paths` list of plain repo-relative paths. `outOfScope` is free text: state what must not be touched in words.",
    parameters: WORKSTREAM_PARAMETERS,
    async execute(_id, raw) {
      // Pi validated `raw` against WORKSTREAM_PARAMETERS before calling execute,
      // so the schema's static type is the true shape here (no runtime re-check).
      const args = raw as WorkstreamArgs;
      const refusal = workstreamCallRefusal(args, accepted);
      if (refusal) throw new Error(refusal);
      accepted.add(args.id);
      return {
        content: [{ type: "text", text: `recorded workstream ${args.id}` }],
        details: { id: args.id },
      };
    },
  });
}
