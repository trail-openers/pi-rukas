#!/usr/bin/env bun
/**
 * pi-rukas-headless — run /work cycles without an interactive Pi session
 * (headless S4, #1024). Entry point for `bin/pi-rukas-headless` and for
 * `pi-rukas run`, which execs it.
 *
 *   pi-rukas-headless work <issue> [more issues] [--restart] [--merge]
 *                          [--timeout <minutes>] [--json]
 *
 * stderr: NDJSON v1 progress lines (ndjson.ts). stdout: one summary line, or
 * with --json exactly one JSON document. The exit code is derived from the
 * state file (exit-code.ts).
 */

import { resolveRepoRoot } from "../work-entry.ts";
import { EXIT } from "./exit-code.ts";
import { runHeadless } from "./run.ts";

export interface ParsedArgs {
  issues: number[];
  restart: boolean;
  mergeGrant: boolean;
  timeoutMs?: number;
  json: boolean;
  sandboxed: boolean;
}

/** Parse argv after the `work` verb. Returns an `error` rather than throwing. */
export function parseHeadlessArgs(argv: string[]): ParsedArgs | { error: string } {
  const issues: number[] = [];
  let restart = false;
  let mergeGrant = false;
  let json = false;
  let sandboxed = false;
  let timeoutMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;
    if (tok === "--restart") restart = true;
    else if (tok === "--merge") mergeGrant = true;
    else if (tok === "--json") json = true;
    else if (tok === "--sandboxed") sandboxed = true;
    else if (tok === "--timeout") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: "--timeout needs minutes > 0" };
      timeoutMs = v * 60_000;
    } else if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      if (n <= 0) return { error: `invalid issue number "${tok}"` };
      issues.push(n);
    } else {
      return { error: `unknown argument "${tok}"` };
    }
  }
  if (issues.length === 0) return { error: "work needs at least one issue number" };
  return { issues, restart, mergeGrant, timeoutMs, json, sandboxed };
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb !== "work") {
    process.stderr.write(
      "usage: pi-rukas-headless work <issue...> [--restart] [--merge] [--timeout <min>] [--json]\n",
    );
    return EXIT.refused;
  }
  const args = parseHeadlessArgs(rest);
  if ("error" in args) {
    process.stdout.write(
      `${JSON.stringify({ error: { code: "bad-arguments", message: args.error } })}\n`,
    );
    return EXIT.refused;
  }
  if (args.sandboxed) {
    process.stdout.write(
      `${JSON.stringify({ error: { code: "sandboxed-refused", message: "--sandboxed is not supported by the headless runner" } })}\n`,
    );
    return EXIT.refused;
  }
  const repoRoot = await resolveRepoRoot(process.cwd());
  const run = await runHeadless({
    repoRoot,
    issues: args.issues,
    restart: args.restart,
    mergeGrant: args.mergeGrant,
    timeoutMs: args.timeoutMs,
    write: (line) => process.stderr.write(`${line}\n`),
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ exitCode: run.exitCode, issues: run.results })}\n`);
  } else {
    const parts = run.results.map((r) => `#${r.issue} ${r.status} (exit ${r.exitCode})`);
    process.stdout.write(`pi-rukas-headless: ${parts.join(", ") || "nothing ran"}\n`);
  }
  return run.exitCode;
}

// Run only when executed directly (bun cli.ts ...), never when imported by a test.
const invokedDirectly = process.argv[1]?.endsWith("cli.ts") === true;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
