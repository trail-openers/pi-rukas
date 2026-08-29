#!/usr/bin/env bun
/**
 * Guard-memory writes from widening findings — the pure write path.
 *
 * Issue #280 C — invariant-removal guard memories. Tests that:
 *   1. A widening finding produces the correct guard-memory content
 *   2. The write function records outcomes (written, skipped-dedup, error)
 *   3. The dedup key is deterministic: `${file}:${symbol}`
 *   4. PI_ENSEMBLE_INVARIANT_MEMORY=0 skips all writes
 */

import {
  type VipuneWriteFn,
  defaultVipuneWrite,
  writeGuardMemories,
} from "../src/guard-memory-write.ts";
import type { WideningFinding } from "../src/invariant-scan.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------ content shape

{
  const finding: WideningFinding = {
    file: "src/engine/embedder.rs",
    kind: "option-widening-rust",
    after: "embedder: Option<EmbeddingEngine>",
    before: "embedder: EmbeddingEngine",
  };

  const calls: Array<{ text: string }> = [];
  const fakeWrite: VipuneWriteFn = async (text) => {
    calls.push({ text });
    return { id: "test-id-1" };
  };

  const results = await writeGuardMemories([finding], 280, "/repo", fakeWrite);

  assert(results.length === 1, "one finding → one result");
  assert(results[0]?.outcome === "written", "outcome is 'written'");
  assert(results[0]?.id === "test-id-1", "id propagated from writeFn");
  // Symbol extraction uses before→after as the symbol; the dedup key is file:symbol
  assert(
    results[0]?.dedupKey.startsWith("src/engine/embedder.rs:"),
    "dedupKey includes file + symbol",
  );
  assert(calls[0].text.includes("invariant-removal"), "content includes the invariant-removal tag");
  assert(calls[0].text.includes("embedder.rs"), "content includes the basename");
  assert(
    calls[0].text.includes("constraint") && calls[0].text.includes("removed in issue #280"),
    "content says constraint before→after removed in issue #280",
  );
  assert(
    calls[0].text.includes("verify what now guarantees"),
    "content says 'verify what now guarantees the old invariant'",
  );
  assert(calls[0].text.length < 1000, "content is under the vipune 1000-char ceiling");
}

// ------------------------------------------ symbol extraction

{
  const cases: Array<{
    finding: WideningFinding;
    expectedKeyPart: string;
  }> = [
    {
      finding: {
        file: "a.rs",
        kind: "option-widening-rust",
        after: "x: Option<T>",
        before: "x: T",
      },
      // Symbol extraction uses the raw before/after values
      expectedKeyPart: "x: T → x: Option<T>",
    },
    {
      finding: {
        file: "b.ts",
        kind: "optional-property",
        after: "name?:",
        before: "name",
      },
      expectedKeyPart: "name → name?:",
    },
    {
      finding: {
        file: "c.rs",
        kind: "removed-assert",
        before: "assert!",
      },
      expectedKeyPart: "removed: assert!",
    },
    {
      finding: {
        file: "d.ts",
        kind: "type-erasure",
        after: "any",
      },
      expectedKeyPart: "widened to: any",
    },
  ];

  for (const { finding, expectedKeyPart } of cases) {
    const calls: string[] = [];
    const fakeWrite: VipuneWriteFn = async (text) => {
      calls.push(text);
      return { id: "x" };
    };
    const results = await writeGuardMemories([finding], 1, "/r", fakeWrite);
    assert(
      results[0]?.dedupKey.includes(expectedKeyPart),
      `dedup key for ${finding.kind}: includes '${expectedKeyPart}'`,
    );
    assert(
      results[0]?.content?.includes(expectedKeyPart),
      `content for ${finding.kind}: includes '${expectedKeyPart}'`,
    );
  }
}

// ------------------------------------------ PI_ENSEMBLE_INVARIANT_MEMORY=0

{
  const calls: string[] = [];
  const fakeWrite: VipuneWriteFn = async (text) => {
    calls.push(text);
    return { id: "x" };
  };

  const original = process.env.PI_ENSEMBLE_INVARIANT_MEMORY;
  process.env.PI_ENSEMBLE_INVARIANT_MEMORY = "0";
  try {
    const results = await writeGuardMemories(
      [
        { file: "a.ts", kind: "type-erasure", after: "any" },
        { file: "b.rs", kind: "removed-mut", before: "mut" },
      ],
      1,
      "/r",
      fakeWrite,
    );
    assert(
      results.every((r) => r.outcome === "skipped-dedup"),
      "all outcomes are 'skipped-dedup' when env is '0'",
    );
    assert(calls.length === 0, "no writeFn calls when env is '0'");
  } finally {
    if (original === undefined) process.env.PI_ENSEMBLE_INVARIANT_MEMORY = undefined;
    else process.env.PI_ENSEMBLE_INVARIANT_MEMORY = original;
  }
}

// ------------------------------------------ multiple findings → multiple writes

{
  const calls: Array<{ text: string }> = [];
  const fakeWrite: VipuneWriteFn = async (text, opts) => {
    calls.push({ text });
    return { id: `id-${calls.length}` };
  };

  const findings: WideningFinding[] = [
    { file: "src/a.ts", kind: "type-erasure", after: "any" },
    { file: "src/b.rs", kind: "option-widening-rust", after: "x: Option<T>" },
    { file: "src/c.ts", kind: "optional-property", before: "name", after: "name?:" },
  ];

  const results = await writeGuardMemories(findings, 42, "/repo", fakeWrite);

  assert(results.length === 3, "one result per finding");
  assert(
    results.every((r) => r.outcome === "written"),
    "all written",
  );
  assert(calls.length === 3, "three writeFn calls");
  assert(calls[0].text.includes("issue #42"), "the issue number is threaded into every content");
}

// ------------------------------------------ error path

{
  const fakeWrite: VipuneWriteFn = async () => {
    throw new Error("vipune process died");
  };

  const results = await writeGuardMemories(
    [{ file: "a.ts", kind: "type-erasure", after: "any" }],
    1,
    "/r",
    fakeWrite,
  );

  assert(results[0]?.outcome === "error", "a thrown writeFn is reported as 'error'");
  assert(
    results[0]?.content !== undefined,
    "the content is still recorded on error (for the plumb-report)",
  );
}

// ------------------------------------------ defaultVipuneWrite returns empty when absent

{
  const r = await defaultVipuneWrite("test content", { cwd: "/repo", issue: 1 });
  assert(
    r.id === undefined,
    "defaultVipuneWrite returns {} when vipune is absent (does not throw)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
