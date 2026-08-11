#!/usr/bin/env bun
/**
 * The write path, and the instrument that says whether any of this helps.
 *
 * The operator's condition for keeping memory on is *"as long as it provides
 * value to agents"* — which is only a condition if it can be checked. Until now
 * it could not be: nothing recorded whether a memory was ever read.
 *
 * Two halves here. The write path must produce rows a later read can find and
 * must refuse to corrupt its own read path; and `memory-stats` must be able to
 * answer the value question from data the CLI refuses to surface.
 */

import { readMemoryStats, renderMemoryStats } from "../src/memory-stats.ts";
import {
  type FindingLike,
  MAX_MEMORY_CHARS,
  MAX_WRITES_PER_CYCLE,
  memoryContentFor,
  validMetadata,
  writeFindings,
} from "../src/memory-write.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ content shape

{
  const f: FindingLike = {
    path: "extension/src/work-driver-lens.ts",
    title: "reviewRound is incremented here and never reset",
    severity: "MEDIUM",
  };
  const c = memoryContentFor(f);
  assert(
    c === "work-driver-lens.ts: reviewRound is incremented here and never reset",
    "content leads with the BASENAME — the token a later query is built from",
  );
  assert(!c.includes("extension/src/"), "...not the full path, which no query will contain");
  assert(c.length <= MAX_MEMORY_CHARS, `...and is within ${MAX_MEMORY_CHARS} chars`);

  const long = memoryContentFor({ ...f, title: "x".repeat(500) });
  assert(long.length <= MAX_MEMORY_CHARS, "an over-long title is truncated, not refused");
  assert(long.endsWith("…"), "...visibly, so a reader knows the claim was cut");

  // The point of the ceiling: a brief carries up to 10 hits, and the live
  // corpus median is 742 chars. Short rows are about prompt cost, not recall.
  assert(
    MAX_MEMORY_CHARS < 1000,
    "the write ceiling is well below the seam's 1000-char refusal, on purpose",
  );
}

// ------------------------------------------- metadata cannot corrupt the read

{
  const good = { src: "pi-ensemble", issue: 422, file: "a.ts", kind: "lens-finding" };
  assert(validMetadata(good), "a well-formed metadata object validates");
  assert(validMetadata({ ...good, cycle: "2" }), "...with an optional cycle");

  for (const [name, bad] of [
    ["wrong src", { ...good, src: "elsewhere" }],
    ["wrong kind", { ...good, kind: "note" }],
    ["issue not a number", { ...good, issue: "422" }],
    ["missing file", { ...good, file: "" }],
    ["cycle not a string", { ...good, cycle: 2 }],
    ["not an object", "just a string"],
    ["null", null],
  ] as const) {
    assert(!validMetadata(bad), `rejected: ${name}`);
  }
}

// --------------------------------------------------- writes, capped and typed

{
  const calls: string[] = [];
  const fakeExec = async (_f: string, args: string[]) => {
    calls.push(args.join(" "));
    return { stdout: JSON.stringify({ status: "added", id: `id-${calls.length}` }), stderr: "" };
  };
  const findings: FindingLike[] = Array.from({ length: 5 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    title: `finding number ${i}`,
    severity: "MEDIUM",
  }));

  const out = await writeFindings(
    findings,
    { src: "pi-ensemble", issue: 422, kind: "lens-finding", cycle: "1" },
    { cwd: "/repo", execFn: fakeExec },
  );

  const written = out.filter((o) => o.outcome === "written");
  const capped = out.filter((o) => o.outcome === "cap");
  assert(
    written.length === MAX_WRITES_PER_CYCLE,
    `exactly ${MAX_WRITES_PER_CYCLE} writes land — the cycle cap holds`,
  );
  assert(capped.length === 2, "...and the surplus is reported as `cap`, not dropped silently");
  assert(
    calls.length === MAX_WRITES_PER_CYCLE,
    "the capped findings never reach the binary at all",
  );
  assert(
    calls.every((c) => c.includes("--status candidate")),
    "every driver write is a CANDIDATE — invisible to a default read until promoted",
  );
  assert(
    calls.every((c) => c.includes("--memory-type guard")),
    "...and typed, so it is never an untyped row",
  );
  assert(!calls.some((c) => c.includes("--force")), "never --force");
  assert(
    calls.every((c) => c.includes("-m ")),
    "...and every write carries metadata",
  );
  const meta = calls[0]?.match(/-m (\{.*?\})/)?.[1];
  assert(
    meta !== undefined && JSON.parse(meta).file === "file-0.ts",
    "metadata anchors the row to the file basename",
  );
}

// ------------------------------------------ the failure paths are not silent

{
  const conflictExec = async () => {
    const e = Object.assign(new Error("exit 2"), {
      code: 2,
      stdout: JSON.stringify({
        status: "conflicts",
        conflicts: [{ id: "x", content: "y", similarity: 0.99 }],
      }),
      stderr: "",
    });
    throw e;
  };
  const out = await writeFindings(
    [{ path: "a.ts", title: "t", severity: "LOW" }],
    { src: "pi-ensemble", issue: 1, kind: "lens-finding" },
    { cwd: "/r", execFn: conflictExec as never },
  );
  assert(out[0]?.outcome === "conflict", "an exit-2 conflict is reported as a conflict");
  assert(/similar row/.test(out[0]?.detail ?? ""), "...and says so, rather than being swallowed");

  const throwExec = async () => {
    throw new Error("vipune exploded");
  };
  const err = await writeFindings(
    [{ path: "a.ts", title: "t", severity: "LOW" }],
    { src: "pi-ensemble", issue: 1, kind: "lens-finding" },
    { cwd: "/r", execFn: throwExec as never },
  );
  assert(
    err[0]?.outcome === "error",
    "a thrown exec is an `error` outcome — never an exception into the driver",
  );
}

// ------------------------------------- the value instrument, on the live store

{
  const s = await readMemoryStats("randomm/pi-ensemble");
  if (!s) {
    console.log("… no live vipune store — skipping the value-instrument check");
  } else {
    assert(s.rows > 0, `reads the live store: ${s.rows} rows`);
    assert(
      s.totalRetrievals > 0,
      `retrieval telemetry IS readable despite vipune#179: ${s.totalRetrievals} retrievals`,
    );
    assert(
      typeof s.neverRetrieved === "number" && s.neverRetrieved <= s.rows,
      `never-retrieved is computable: ${s.neverRetrieved}/${s.rows}`,
    );
    assert(
      Object.keys(s.byStatus).length > 0 && Object.keys(s.byType).length > 0,
      "status and type are recovered — neither is returned by any vipune command",
    );
    const r = renderMemoryStats(s);
    assert(/never retrieved/.test(r) && /retrievals/.test(r), "the summary names both signals");
  }

  const absent = await readMemoryStats("no-such-project-xyz");
  assert(absent === undefined, "an unknown project yields undefined, not a throw");
  const noDb = await readMemoryStats("x", "/nonexistent/path/to.db");
  assert(noDb === undefined, "a missing database yields undefined — never a failed command");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
