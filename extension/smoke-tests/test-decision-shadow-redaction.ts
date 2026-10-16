#!/usr/bin/env bun
/**
 * The shadow seams bound their untrusted text by REDACTING THE WHOLE VALUE
 * FIRST and clipping after (#1393). The order is the whole point: clip-then-
 * redact cuts a credential into a fragment no pattern recognises, and a plain
 * `includes(secret)` check then passes while the secret is still readable — so
 * every assertion here asks whether any 12-char window of the key survived.
 *
 * Both shadow seams are covered, at the exact offset where their declared bound
 * falls inside a credential: the 600-char failure tail (kept from the END) and
 * the 1000-char open point (kept from the START).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { attach, detach } from "../src/decision-shadow.ts";
import { classifyFailureCause, shadowFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";
import {
  STUB_MODEL,
  llmReply,
  makeAssert,
  records,
  stubRegistry,
  tmpDir,
} from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function awaitRecords(file: string, n: number): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 200 && records(file).length < n; i++) await sleep(10);
  return records(file);
}

type Tail = Parameters<typeof classifyFailureCause>[0];
type Where = Parameters<typeof shadowFailureCause>[2];
function act(tail: Tail, where: Where) {
  const cls = classifyFailureCause(tail);
  shadowFailureCause(tail, cls, where);
  return cls;
}
const spec = (): NormalisedSpec => ({
  intent: "Apply the change.",
  deliverables: [{ id: "d1", description: "apply the change", paths: [] }],
  acceptanceCriteria: ["it works"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "actionable",
});
const issueWith = (...points: string[]) =>
  `## Open points (unresolved at the gap-gate cap)\n\n${points.map((p) => `- [CRITICAL] ${p}`).join("\n")}\n`;

/** True when any 12-char run of `key` appears in `s` (a fragment that could still leak). */
function leaksKey(s: string, key: string): boolean {
  for (let i = 0; i + 12 <= key.length; i++) {
    if (s.includes(key.slice(i, i + 12))) return true;
  }
  return false;
}

const SHADOW_KEY = `sk-ant-api03-${"aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d"}`;
{
  // The key's prefix sits ~10 chars before the 600-char tail boundary: a clip
  // before redaction would leave a fragment no pattern matches.
  const root = tmpDir("shadow-redact-tail");
  const where = { repoRoot: root, issues: [9] };
  const log = path.join(root, ".pi", "work-state", "9", "decisions.jsonl");
  const prompts: string[] = [];
  const { registry, calls } = stubRegistry({
    llm: (ctx) => {
      prompts.push(String(ctx.messages[0]?.content ?? ""));
      return llmReply(JSON.stringify({ label: "subagent-failure", justification: "stub" }));
    },
  });
  attach({ modelRegistry: registry, model: STUB_MODEL, cwd: root });
  // Spaces around the key: the pattern needs word boundaries at both ends.
  const errorTail = `${"f".repeat(99)} ${SHADOW_KEY} ${"t".repeat(556)}`;
  assert(
    errorTail.length - 600 === 100 + 10,
    "fixture: the 600-char tail boundary falls 10 chars into the key",
  );
  act({ kind: "dispatch-failed", errorTail }, where);
  const recs = await awaitRecords(log, 1);
  assert(
    calls.llm === 1 && recs.length === 1,
    "fixture: the failure-cause call reached the backend",
  );
  assert(
    !prompts.some((p) => leaksKey(p, SHADOW_KEY)),
    "tail clip: no 12+ char run of the key reaches the backend",
  );
  assert(
    !leaksKey(readFileSync(log, "utf8"), SHADOW_KEY),
    "tail clip: no 12+ char run of the key reaches the decision log",
  );

  // The 1000-char open-point clip, same placement from the start.
  const point = `${"p".repeat(989)} ${SHADOW_KEY} ${"q".repeat(49)}`;
  finaliseSpecVerdict(spec(), issueWith(point), where);
  await awaitRecords(log, 2);
  await sleep(50);
  assert(
    !prompts.some((p) => leaksKey(p, SHADOW_KEY)),
    "open-point clip: no 12+ char run of the key reaches the backend",
  );
  assert(
    !leaksKey(readFileSync(log, "utf8"), SHADOW_KEY),
    "open-point clip: no 12+ char run of the key reaches the decision log",
  );
  detach();
}

process.exit(state.exit);
