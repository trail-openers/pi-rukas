/**
 * headless-verb-harness — runs one S6 subcommand (#1021) through cli.ts's
 * runSubcommand and checks the output contract every subcommand shares:
 * exactly one JSON document on stdout, and at least one NDJSON v1 line on
 * stderr, every line valid against the v1 schema.
 */

import { runSubcommand } from "../src/headless/cli.ts";
import type { VerbContext, VerbOutcome } from "../src/headless/verb.ts";
import { validateNdjsonLine } from "../src/headless/ndjson.ts";

export interface VerbRun {
  code: number;
  doc: Record<string, unknown>;
  /** The NDJSON lines, parsed. */
  lines: Record<string, unknown>[];
  /** Contract violations; empty when stdout and stderr hold their shape. */
  violations: string[];
}

export async function runVerb(
  verb: string,
  argv: string[],
  repoRoot: string,
  run?: (argv: readonly string[], ctx: VerbContext) => Promise<VerbOutcome>,
): Promise<VerbRun> {
  const raw: string[] = [];
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await runSubcommand(verb, argv, repoRoot, (line) => raw.push(line), run);
  } finally {
    process.stdout.write = write;
  }
  const violations: string[] = [];
  const docs = out
    .join("")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (docs.length !== 1) violations.push(`stdout holds ${docs.length} documents, not 1`);
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(docs[0] ?? "") as Record<string, unknown>;
  } catch {
    violations.push("stdout is not JSON");
  }
  const lines: Record<string, unknown>[] = [];
  for (const l of raw) {
    try {
      const parsed = JSON.parse(l) as Record<string, unknown>;
      for (const v of validateNdjsonLine(parsed)) violations.push(`stderr line: ${v}`);
      lines.push(parsed);
    } catch {
      violations.push(`stderr line is not JSON: ${l.slice(0, 80)}`);
    }
  }
  if (!lines.some((l) => l.v === 1)) violations.push("no NDJSON v1 line on stderr");
  return { code, doc, lines, violations };
}

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
