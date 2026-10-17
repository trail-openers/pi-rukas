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
import { SEAMS, type SeamSpec } from "../src/decision-seam-registry.ts";
import { attach, detach, shadowExactRuleMatch, shadowSkip } from "../src/decision-shadow.ts";
import { classifyFailureCause, shadowFailureCause } from "../src/work-driver-failure-taxonomy.ts";
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

  // The head clip, same placement from the START — asserted on the real shadow
  // writer rather than on a second record the old block awaited. Nothing writes
  // an open-point record any more: main's #1395 deleted the S4 seam's caller, and
  // `finaliseSpecVerdict(spec, body)` takes two arguments and redacts its open
  // points through the open-point reader, not through a seam. So this fires
  // `shadowExactRuleMatch` against a tests-only seam whose field bound keeps the
  // HEAD at 1000 chars — the bound the retired open-point seam declared — with a
  // state whose boundary falls 10 chars into the key, and asks the same question
  // of the bytes on disk: does any 12-char window survive the seam's own clip
  // (#1393).
  (SEAMS as Record<string, SeamSpec>)["fixture-head-clip"] = {
    ...(SEAMS as Record<string, SeamSpec>)['failure-cause'],
    id: "fixture-head-clip",
    fields: { openPoint: { max: 1000 } },
  };
  const point = `${"p".repeat(990)} ${SHADOW_KEY} ${"q".repeat(49)}`;
  // The key starts at index 991 and runs 53 chars, so index 1000 — the boundary
  // of a 1000-char head clip — sits 10 chars inside it. That is the shape a
  // clip-before-redaction bug survives: the kept half carries a 10-char fragment
  // no pattern matches, so only `leaksKey` sees it.
  assert(
    SHADOW_KEY.length === 53 &&
      point.indexOf(SHADOW_KEY) === 991 &&
      point.length > 1000 &&
      point.slice(1000, 1001) === "i",
    `fixture: the 1000-char head boundary falls 10 chars into the key (${point.indexOf(SHADOW_KEY)})`,
  );
  await shadowExactRuleMatch(
    "fixture-head-clip" as never,
    { question: "q", rule: "unknown" },
    where,
    { openPoint: point },
  );
  const after = await records(log);
  assert(
    after.length === 2 && (after[1] as { state?: unknown }).state !== undefined,
    "fixture: the seam-bounded state reached the record rather than being dropped",
  );
  assert(
    !leaksKey(readFileSync(log, "utf8"), SHADOW_KEY),
    "open-point clip: no 12+ char run of the key reaches the decision log",
  );
  detach();
}

// ------------------------------------- the shadow writer survives an unknown seam

{
  // `writeShadowRecord` is documented NEVER THROWS, and it is reached with a
  // caller-supplied seam id from `shadowSkip` / `shadowExactRuleMatch` — so it
  // must look the seam up the way `decide()` does (`Object.hasOwn`, not a bare
  // index) and skip the seam-bounded state rather than calling `boundedState`
  // with `undefined`. A typo'd or removed id is a dropped trace, never a
  // `TypeError` out of a fire-and-forget path (#1393).
  const root = tmpDir("shadow-unknown-seam");
  const where = { repoRoot: root, issues: [11] };
  let threw = false;
  try {
    await shadowExactRuleMatch("no-such-seam" as never, { question: "q", rule: "fatal" }, where, {
      cause: "anything at all",
    });
    await shadowSkip("no-such-seam" as never, { question: "q", rule: "fatal" }, where, "skipped");
  } catch {
    threw = true;
  }
  assert(!threw, "shadowExactRuleMatch/shadowSkip on an unregistered seam do not throw");
  assert(
    records(path.join(root, ".pi", "work-state", "11", "decisions.jsonl")).length > 0,
    "the unknown-seam record still lands, with no seam-bounded state",
  );
}

process.exit(state.exit);
