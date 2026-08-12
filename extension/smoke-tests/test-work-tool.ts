#!/usr/bin/env bun
/**
 * PM must be able to START a cycle, and must not be able to authorise a merge.
 *
 * The incident: a PM killed a `/work` cycle over `needs-human-attention`
 * labels, found no way to start another, and reimplemented the driver by hand
 * — no state file, no queue, no handoff artifact, no review-cap timer, and a
 * branch the driver knew nothing about. Doctrine forbidding that already
 * existed; the thing to call instead did not.
 *
 * The hard constraint on the way in: `--merge` is one of two `AuthoritySource`s
 * and the only one that bypasses the #406/#407 policy judge. An LLM-settable
 * boolean there is a cycle granting itself merge authority. So the tool has no
 * such parameter, and no path through it can set the grant.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { registerWorkTools } from "../src/work-tool.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface Registered {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  execute: (...a: unknown[]) => Promise<unknown>;
}

const tools: Registered[] = [];
const fakePi = {
  registerTool(def: Registered) {
    tools.push(def);
  },
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
} as any;

registerWorkTools(fakePi);

// ------------------------------------------------------- both tools register

{
  const names = tools.map((t) => t.name).sort();
  assert(
    names.join(",") === "load_workflow_doctrine,start_work_driver",
    `both tools register: ${names.join(", ")}`,
  );
}

// ------------------------------------------ merge authority is unreachable

{
  const work = tools.find((t) => t.name === "start_work_driver");
  const props = Object.keys(work?.parameters.properties ?? {});
  assert(
    !props.some((p) => /merge/i.test(p)),
    `canary: no merge parameter exists — params are ${props.join(", ")}`,
  );
  assert(
    props.includes("issues") && props.includes("restart"),
    "...but issues and restart do, so the tool is actually usable",
  );
  assert(
    /operator-only|cannot be requested/i.test(work?.description ?? ""),
    "the description says merge authority is not available here",
  );

  // The source must force it off rather than merely omit it: `parseWorkArgs`
  // reads `--merge`, and an issues array is stringified into that same parser.
  const src = readFileSync(path.resolve(import.meta.dirname, "..", "src", "work-tool.ts"), "utf8");
  assert(
    /mergeGrant:\s*false/.test(src),
    "canary: mergeGrant is forced to false, not just left unset",
  );
}

// ------------------------------------ the doctrine tool covers the prose set

{
  const doctrine = tools.find((t) => t.name === "load_workflow_doctrine");
  const nameParam = doctrine?.parameters.properties?.name as { anyOf?: Array<{ const?: string }> };
  const allowed = (nameParam?.anyOf ?? []).map((v) => v.const).filter(Boolean) as string[];
  assert(allowed.length === 6, `six workflows are loadable: ${allowed.join(", ")}`);
  assert(
    !allowed.includes("work"),
    "canary: /work is NOT loadable as prose — handing PM its body invites the hand-rolling this prevents",
  );
  for (const expected of ["research", "plan", "review", "audit", "start", "do"]) {
    assert(allowed.includes(expected), `  /${expected} is reachable`);
  }
}

// ------------------------------------------ the doctrine line is in the preamble

{
  const commands = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "commands.ts"),
    "utf8",
  );
  const preamble = commands.slice(
    commands.indexOf("const PM_STICKY_PREAMBLE"),
    commands.indexOf("const PM_STICKY_PREAMBLE") + 3000,
  );
  assert(
    /COMPILED DRIVER/.test(preamble),
    "the sticky preamble — re-injected every turn — says /work is a compiled driver",
  );
  assert(
    /start_work_driver/.test(preamble),
    "...and names the tool to call instead of reconstructing it",
  );
  assert(
    /Merge authority is operator-only/.test(preamble),
    "...and that neither tool can grant merge authority",
  );
  // The pre-existing rule forbade editing files, not reimplementing the
  // pipeline — which is exactly the gap PM walked through.
  assert(
    /doctrine violation/.test(preamble),
    "the original no-editing rule is still present, not replaced",
  );
}

// -------------------------------------------------- gh pr diff is permitted

{
  const agents = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "..", "..", "agents.json"), "utf8"),
  ) as { agent?: Record<string, { permission?: { bash?: Record<string, string> } }> };
  const bash = agents.agent?.["project-manager"]?.permission?.bash ?? {};
  assert(Object.keys(bash).length > 0, "the project-manager bash permission map is found at all");
  assert(
    bash["gh pr diff*"] === "allow",
    "PM may run `gh pr diff` — the one real /review gap, and read-only",
  );
  assert(bash["gh pr view*"] === "allow", "...alongside the pr reads it already had");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
