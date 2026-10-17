/**
 * Shared fixtures for the decision-seam smoke tests (#1308): fixture seams,
 * stub backends and a stub model registry. Everything is offline — the stub
 * registry answers from closures, never from a network.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Backend, BackendResult, DecisionRegistry } from "../../src/decision-backends.ts";
import { SEAMS, type SeamId, type SeamSpec } from "../../src/decision-seam-registry.ts";

export function makeAssert() {
  const state = { exit: 0 };
  const assert = (cond: boolean, msg: string) => {
    if (cond) console.log(`✓ ${msg}`);
    else {
      console.error(`✗ ${msg}`);
      state.exit = 1;
    }
  };
  return { assert, state };
}

/** A valid, shadow-by-default fixture seam. */
export function fixtureSpec(over: Partial<SeamSpec> = {}): SeamSpec {
  return {
    id: "fixture",
    kind: "choice",
    instructions: "Is the thing ok?",
    labels: { ok: "fine", flag: "needs a human" },
    ruleDefault: "flag",
    passing: ["ok"],
    composition: "advisory",
    defaultMode: "shadow",
    evidence: "none",
    owner: "fixture.ts",
    timeoutMs: 2000,
    tokenBudget: 8000,
    ...over,
  };
}

/**
 * Register a fixture seam so `decide()` can be driven through it. Tests only:
 * production seams are declared in the registry source, where the contract
 * test reads them.
 */
export function registerFixture(spec: SeamSpec): SeamId {
  (SEAMS as Record<string, SeamSpec>)[spec.id] = spec;
  return spec.id as SeamId;
}

export function envKey(prefix: string, id: string): string {
  return `${prefix}_${id.toUpperCase().replaceAll("-", "_")}`;
}

/** A backend that answers from a fixed result and counts its calls. */
export function stubBackend(
  result: BackendResult | (() => Promise<BackendResult>),
  name = "stub",
): Backend & { calls: number } {
  const b = {
    name,
    source: "llm" as const,
    calls: 0,
    run: async () => {
      b.calls++;
      return typeof result === "function" ? result() : result;
    },
  };
  return b;
}

export interface StubRegistryOpts {
  classifier?: (ctx: unknown) => unknown;
  llm?: (ctx: { systemPrompt?: string; messages: { content: unknown }[] }) => unknown;
}

/** A model registry whose classify/streamSimple are closures. */
export function stubRegistry(opts: StubRegistryOpts): {
  registry: DecisionRegistry;
  calls: { classify: number; llm: number };
} {
  const calls = { classify: 0, llm: 0 };
  const registry = {
    getModelOfType: () => (opts.classifier ? { provider: "stub", id: "cls" } : undefined),
    classify: async (_m: unknown, ctx: unknown) => {
      calls.classify++;
      return opts.classifier?.(ctx);
    },
    streamSimple: (
      _m: unknown,
      ctx: { systemPrompt?: string; messages: { content: unknown }[] },
    ) => {
      calls.llm++;
      const msg = opts.llm?.(ctx);
      return { result: async () => msg };
    },
  };
  // The registry's real types are Pi's generics; a structural stub is all a test needs.
  return { registry: registry as unknown as DecisionRegistry, calls };
}

export const STUB_MODEL = { provider: "stub", id: "chat" } as never;

/** An assistant message carrying `text` with the given stop reason. */
export function llmReply(text: string, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } },
  };
}

export function tmpDir(tag: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `decision-${tag}-`));
}

/**
 * A credential long enough that any 12-char window of it is recognisable, and
 * the probe that asks whether any such window survived a clip. A clip that ran
 * BEFORE redaction leaves a fragment no pattern matches, and a plain
 * `includes(key)` check would then pass — so this is the only sound leak test.
 */
export const PROBE_KEY = `sk-ant-api03-${"aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d"}`;

export function leaksKey(s: string, key: string, window = 12): boolean {
  for (let i = 0; i + window <= key.length; i++) {
    if (s.includes(key.slice(i, i + window))) return true;
  }
  return false;
}

/**
 * Text whose `boundary`th character falls `offset` chars INSIDE `key`, so the
 * clip keeps the head of a credential whose tail it cut. That is the shape a
 * clip-before-redaction bug survives: the fragment is not a match for any
 * pattern, so only `leaksKey` can see it.
 */
export function keyAtBoundary(
  key: string,
  boundary: number,
  offset: number,
  direction: "start" | "end",
): string {
  const head = "f".repeat(Math.max(0, boundary - offset - 1));
  const tail = "t".repeat(Math.max(0, boundary + 100));
  return direction === "start" ? `${head}${key}${tail}` : `${tail} ${key} ${head}`;
}

/**
 * The records of a JSONL decision log. Absent or unreadable is an EMPTY log, not
 * an error: the shadow writer is fire-and-forget, so a poll routinely reads the
 * file before the first append lands, and a test must not need a guard at every
 * call site to ask "how many so far". This is the ONE reader — a test re-declaring
 * it drifts (four local copies disagreed on whether a missing file threw).
 */
export function records(file: string): Record<string, unknown>[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}
