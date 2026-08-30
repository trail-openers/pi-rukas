#!/usr/bin/env bun
/**
 * Verify that stripPmTools correctly removes `edit` and `write` from the
 * active tool set, and that all other tools (built-in read-only + extension)
 * survive the `setActiveTools` REPLACE call.
 *
 * Does NOT require a live Pi child — it exercises the pure filtering logic
 * with a minimal ExtensionAPI stub so the gate is fast and offline.
 */

import { getPmModeStripInfo, stripPmTools } from "../src/commands.ts";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// A minimal stub that mirrors what Pi's real ExtensionAPI exposes.
function makeStub(): ExtensionAPI & {
  _capturedActiveTools: string[];
  _allTools: ToolInfo[];
  _callCount: number;
} {
  const allTools: ToolInfo[] = [
    { name: "read", description: "Read a file" },
    { name: "bash", description: "Run a shell command" },
    { name: "edit", description: "Edit a file" },
    { name: "write", description: "Write a file" },
    { name: "grep", description: "Search for text" },
    { name: "find", description: "Find files" },
    { name: "ls", description: "List directory" },
    // Extension tools that should SURVIVE the strip.
    { name: "dispatch_specialist", description: "Dispatch a specialist" },
    { name: "dispatch_parallel", description: "Dispatch parallel specialists" },
    { name: "adversarial_loop", description: "Run adversarial review loop" },
    { name: "dispatch_status", description: "Check dispatch status" },
    { name: "dispatch_kill", description: "Kill a dispatch" },
    { name: "dispatch_peek", description: "Peek at a dispatch" },
    { name: "dispatch_steer", description: "Steer a running dispatch" },
    { name: "check_review_cap", description: "Check review round cap" },
    { name: "dispatch_lens_review", description: "Run six-pass lens review" },
    { name: "start_work_driver", description: "Start the compiled /work driver" },
    { name: "load_workflow_doctrine", description: "Load workflow doctrine text" },
    { name: "agents_md_run", description: "Manage AGENTS.md" },
    // Companion tools registered in child processes — still in the stub
    // because getAllTools() in the real Pi returns them too.
    { name: "report_finding", description: "Report a lens finding" },
    { name: "report_policy", description: "Report a policy answer" },
  ];

  let activeTools: string[] = allTools.map((t) => t.name);

  return {
    _allTools: allTools,
    _capturedActiveTools: [],
    _callCount: 0,
    getAllTools: () => allTools,
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
      return undefined as never; // never returns in Pi's actual API
    },
    // Stub out the remaining ExtensionAPI methods with no-ops.
    registerCommand: () => {},
    registerTool: () => {},
    on: () => {},
    sendUserMessage: async () => {},
    createInlinePrompt: () => {},
    createSteerMessage: async () => ({ id: "", messages: [] }),
    setModel: () => {},
    createModelPicker: () => {},
    createSessionPicker: () => {},
    createRunPicker: () => {},
  } as unknown as ExtensionAPI & {
    _capturedActiveTools: string[];
    _allTools: ToolInfo[];
    _callCount: number;
  };
}

{
  // Act: call stripPmTools.
  const stub = makeStub();
  stripPmTools(stub as ExtensionAPI);
  const info = getPmModeStripInfo();

  // Assert 1: info was recorded.
  assert(info !== null, "strip info captured after call");

  // Assert 2: exactly 2 tools removed (edit + write).
  assert(info!.removed === 2, `exactly 2 tools removed (edit + write), got ${info!.removed}`);

  // Assert 3: the removed names are exactly edit and write.
  const removedSorted = [...info!.names].sort();
  assert(
    removedSorted[0] === "edit" && removedSorted[1] === "write",
    `removed tools are edit + write, got: ${removedSorted.join(", ")}`,
  );

  // Assert 4: total includes all built-in + extension tools.
  assert(info!.total === stub._allTools.length, `total is ${info!.total} (all registered tools)`);

  // Assert 5: active set does NOT contain write-capable tools.
  const active = stub.getActiveTools();
  assert(
    !active.includes("edit") && !active.includes("write"),
    "getActiveTools() does not include edit or write",
  );

  // Assert 6: all extension tools are still active (the REPLACE semantics).
  const extensionTools = [
    "dispatch_specialist",
    "dispatch_parallel",
    "adversarial_loop",
    "dispatch_status",
    "dispatch_kill",
    "dispatch_peek",
    "dispatch_steer",
    "check_review_cap",
    "dispatch_lens_review",
    "start_work_driver",
    "load_workflow_doctrine",
    "agents_md_run",
    "report_finding",
    "report_policy",
  ];
  const missing = extensionTools.filter((t) => !active.includes(t));
  assert(
    missing.length === 0,
    `all extension tools survive: ${missing.length === 0 ? "OK" : `missing: ${missing.join(", ")}`}`,
  );

  // Assert 7: all read-only builtins are still active.
  const readOnlyBuiltins = ["read", "bash", "grep", "find", "ls"];
  const missingBuiltins = readOnlyBuiltins.filter((t) => !active.includes(t));
  assert(
    missingBuiltins.length === 0,
    `all read-only builtins active: ${missingBuiltins.length === 0 ? "OK" : `missing: ${missingBuiltins.join(", ")}`}`,
  );

  // Assert 8: active set size is total minus the 2 removed.
  assert(
    active.length === info!.total - info!.removed,
    `active set size is ${active.length} (expected ${info!.total - info!.removed})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
