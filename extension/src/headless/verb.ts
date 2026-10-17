/**
 * headless/verb — what the plan, research, agents-md and lens-review
 * subcommands share (headless S6, #1021).
 *
 * Each subcommand prints exactly one JSON document on stdout (`--json` is
 * accepted and changes nothing) and writes NDJSON `log` lines on stderr
 * through its DriverHost. A subcommand returns a `VerbOutcome`; cli.ts prints
 * it and exits with its code. Bad arguments are refused with exit 40 and the
 * `bad-arguments` error `work` uses.
 */

import type { DriverHost } from "../work-driver-host.ts";
import { EXIT } from "./exit-code.ts";

export interface VerbOutcome {
  exitCode: number;
  doc: Record<string, unknown>;
}

/** What every subcommand runs with. `host` is the headless DriverHost. */
export interface VerbContext {
  repoRoot: string;
  host: DriverHost;
}

/** The refusal for argv a subcommand cannot run. */
export function badArguments(message: string): VerbOutcome {
  return { exitCode: EXIT.refused, doc: { error: { code: "bad-arguments", message } } };
}

export interface FlagSpec {
  /** Flags that take no value. */
  bool: readonly string[];
  /** Flags that take one value (the next argv entry). */
  value: readonly string[];
}

export interface ParsedFlags {
  bool: Set<string>;
  value: Map<string, string>;
  positional: string[];
}

/** Parse argv against `spec`. An unknown flag or a flag missing its value is an error. */
export function parseFlags(
  argv: readonly string[],
  spec: FlagSpec,
): ParsedFlags | { error: string } {
  const out: ParsedFlags = { bool: new Set(), value: new Map(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;
    if (!tok.startsWith("--")) out.positional.push(tok);
    else if (spec.bool.includes(tok)) out.bool.add(tok);
    else if (spec.value.includes(tok)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${tok} needs a value` };
      out.value.set(tok, v);
    } else return { error: `unknown argument "${tok}"` };
  }
  return out;
}
