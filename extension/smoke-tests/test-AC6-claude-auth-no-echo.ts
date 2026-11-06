#!/usr/bin/env bun
/**
 * AC6 — a refusal never echoes the command text.
 *
 * The trace line and the `reason` are the two strings a refusal writes that
 * leave the process: stderr is mirrored into the run transcript and the headless
 * console has no redaction in front of it, and the reason is handed back to the
 * model, which repeats it in its report. `public-hygiene-no-leak.ts` established
 * the rule for the hygiene guard for exactly that reason; a command line carries
 * whatever the agent put next to the verb — a token, a path, a URL.
 *
 * Two probes, because a leak has two routes:
 *   1. the literal route — the sentinel sits verbatim in the command;
 *   2. the decoded route — `bash -c "…"` hides it inside a script body, which a
 *      guard must UNQUOTE in order to match at all. The whole reason the hygiene
 *      guard names categories and line numbers instead of text is that the
 *      decoded body is the text most likely to be pasted into a refusal.
 *
 * The sentinel is built from pieces so this file is not itself a copy of it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { resetPublicHygieneRegistrationForTests } from "../src/public-hygiene-guard.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const FILE = "test-AC6-claude-auth-no-echo.ts";
const realExit = process.exit;

const SENTINEL = ["sk-proj", "deadbeef", "TOPSECRET"].join("-");
const HOST = ["private", "example", "invalid"].join(".");

const PROBES: Array<[string, string]> = [
  ["literal", `claude auth logout --token ${SENTINEL} https://${HOST}/x`],
  ["decoded shell body", `bash -c "claude auth logout --token ${SENTINEL} https://${HOST}/x"`],
];

async function fire(command: string) {
  const env: Record<string, string | undefined> = {
    PI_ENSEMBLE_ROLE: "developer",
    PI_ENSEMBLE_TRUST_MODE: "1",
    PI_ENSEMBLE_SANDBOX_MODE: undefined,
    PI_ENSEMBLE_SUBAGENT_MODE: undefined,
    PI_ENSEMBLE_WRITE_ROOT: undefined,
    PI_ENSEMBLE_ALLOW_CLAUDE_AUTH: undefined,
    PI_ENSEMBLE_PUBLIC_DENYLIST: "/nonexistent/pi-rukas-ac6-denylist",
    // The trace gate must be ON: a capture the test never enabled proves nothing.
    PI_ENSEMBLE_DEBUG: "1",
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    resetPublicHygieneRegistrationForTests();
    const handlers: Array<(e: unknown, c: unknown) => unknown> = [];
    const pi = {
      on: (event: string, fn: (e: unknown, c: unknown) => unknown) => {
        if (event === "tool_call") handlers.push(fn);
      },
    } as unknown as ExtensionAPI;
    childGuards(pi);
    const results = await Promise.all(
      handlers.map((h) => h({ toolName: "bash", input: { command } }, {})),
    );
    return {
      refusal: results.find((r) => (r as { block?: boolean })?.block === true) as
        | { block?: boolean; reason?: string }
        | undefined,
      stderr: written.join(""),
    };
  } finally {
    process.stderr.write = realWrite;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

for (const [label, probe] of PROBES) {
  const { refusal, stderr } = await fire(probe);
  assert(
    refusal?.block === true,
    `${FILE}: ${label}: the probe is refused (an echo check on an inert guard proves nothing)`,
  );
  const reason = refusal?.reason ?? "";
  assert(
    reason !== "",
    `${FILE}: ${label}: the refusal carries a reason an agent can act on`,
  );
  assert(
    !reason.includes(SENTINEL),
    `${FILE}: ${label}: the refusal reason does not echo the command's token`,
  );
  assert(
    !reason.includes(HOST),
    `${FILE}: ${label}: the refusal reason does not echo the command's host`,
  );
  assert(
    !stderr.includes(SENTINEL),
    `${FILE}: ${label}: the trace/stderr does not echo the token (the transcript captures stderr unredacted)`,
  );
  assert(
    !stderr.includes(HOST),
    `${FILE}: ${label}: the trace/stderr does not echo the host`,
  );
  // Still auditable: the line must record WHAT was blocked, by name, the way
  // `memory-write-guard` prints a verb label rather than the command.
  assert(
    /claude/i.test(stderr) && /block|refus/i.test(stderr),
    `${FILE}: ${label}: the trace line records the block by name so the guard stays auditable`,
  );
}

process.exit = realExit;
console.log(`exit ${exit}`);
realExit(exit);
