/**
 * Test helper (#1652): the tool-call transcript a /work plan child produces.
 *
 * Plan fixtures used to be markdown `## Workstreams` blocks returned as the
 * child's reply text. The plan step now reads workstreams from its
 * `report_workstream` calls, so a fixture is a `DispatchResult`-shaped object:
 * the calls in `toolUses`, and the results Pi would record in `toolResults`.
 *
 * `planResultFromMarkdown` converts the old block shape into those calls, so a
 * fixture's meaning is unchanged. It applies the child-side rules the real
 * companion applies (workstream-reporter.ts): a duplicate id is an error result
 * naming the duplicate, and that call contributes nothing.
 */

import { workstreamCallsOf } from "../../src/work-driver-plan-calls.ts";
import { extractListField, sliceMarkdownSection } from "../../src/work-driver-plan-parse.ts";

export interface PlanResultShape {
  text: string;
  toolUses: unknown[];
  toolResults: Array<{ toolCallId: string; toolName: string; isError: boolean; text: string }>;
}

/** A workstream as a `report_workstream` call's arguments. */
export interface WorkstreamArgs {
  id: string;
  scope: string;
  paths: string[];
  outOfScope: string[];
  dependsOn?: string[];
  integrationTest?: string;
  introduces?: string[];
  consumes?: string[];
}

/** A plan result whose calls report exactly these workstreams, in order. */
export function planResultFromCalls(calls: WorkstreamArgs[], text = ""): PlanResultShape {
  return planResultFromRawCalls(
    calls.map((args) => ({ id: args.id, args })),
    text,
  );
}

/**
 * Calls by raw `args` — used where a test needs a call the schema would refuse
 * (the args are not validated here: the refusal is modelled by the result).
 */
export function planResultFromRawCalls(
  entries: Array<{ id: string; args: Record<string, unknown>; refused?: string }>,
  text = "",
): PlanResultShape {
  const toolUses: unknown[] = [];
  const toolResults: PlanResultShape["toolResults"] = [];
  const seen = new Set<string>();
  entries.forEach((entry, i) => {
    const toolCallId = `call-${i + 1}`;
    toolUses.push({
      type: "toolCall",
      id: toolCallId,
      name: "report_workstream",
      arguments: entry.args,
    });
    const id = String(entry.args.id ?? "");
    let refusal = entry.refused;
    if (!refusal && seen.has(id)) {
      refusal = `workstream id '${id}' was already reported in this plan — each workstream needs a distinct id. This call was refused and added nothing; call again with a distinct id.`;
    }
    if (refusal) {
      toolResults.push({ toolCallId, toolName: "report_workstream", isError: true, text: refusal });
    } else {
      seen.add(id);
      toolResults.push({
        toolCallId,
        toolName: "report_workstream",
        isError: false,
        text: `recorded workstream ${id}`,
      });
    }
  });
  return { text, toolUses, toolResults };
}

/**
 * The old markdown fixture shape → the calls it stands for. Only the FIRST
 * `## Workstreams` block is read, matching the production parser it replaces.
 */
export function planResultFromMarkdown(markdown: string): PlanResultShape {
  const section = sliceMarkdownSection(markdown, "Workstreams") ?? "";
  const headingRe = /^###\s+([a-z0-9][a-z0-9_-]*)(?:\s+[—–-]\s+(.+?))?\s*$/gim;
  const heads: Array<{ index: number; length: number; id: string; scope: string }> = [];
  for (const m of section.matchAll(headingRe)) {
    heads.push({
      index: m.index ?? 0,
      length: m[0].length,
      id: m[1] ?? "",
      scope: (m[2] ?? "").trim() || (m[1] ?? ""),
    });
  }
  const calls: WorkstreamArgs[] = heads.map((h, i) => {
    const body = section.slice(h.index + h.length, heads[i + 1]?.index ?? section.length);
    const dependsOn = extractListField(body, "depends[- _]on");
    const integrationTest = extractListField(body, "integration[- _]test")[0];
    const introduces = extractListField(body, "introduces");
    const consumes = extractListField(body, "consumes");
    return {
      id: h.id,
      scope: h.scope,
      paths: extractListField(body, "paths"),
      outOfScope: extractListField(body, "out[- ]of[- ]scope"),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(integrationTest ? { integrationTest } : {}),
      ...(introduces.length > 0 ? { introduces } : {}),
      ...(consumes.length > 0 ? { consumes } : {}),
    };
  });
  return planResultFromCalls(calls, markdown);
}

/**
 * The workstream map a markdown fixture's calls produce, read by the PRODUCTION
 * reader (`workstreamCallsOf`), so a test asserts on what the plan step keeps.
 */
export function workstreamsFromMarkdown(markdown: string): Record<string, WorkstreamArgs> {
  return workstreamCallsOf(planResultFromMarkdown(markdown)).workstreams as Record<
    string,
    WorkstreamArgs
  >;
}
