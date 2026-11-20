#!/usr/bin/env bun
/**
 * lib/lean-continuation-child — the fake resumed child the two `developer-session-continuation`
 * suites share.
 *
 * `test-lean-review-fixer-bound.ts` pins the child that comes UP (its argv, its env, its cwd, its
 * reply, its cost); `test-lean-review-fixer-precommit.ts` pins the two refusals that must land before
 * any child exists. Both need the same fake process answering a canned rpc stream, and a second copy
 * of the stub is a second place a field can drift while both stay green — the same reason
 * `lean-review-fix-reask-fixtures.ts` exists for the wave-level suites.
 *
 * Nothing here decides an expectation: every builder returns a value the CALLING case asserts on.
 */

import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

/** The fence and tree one case hands the child. */
export const FENCE = {
  root: "/run/.worktrees/lean-7-fix-a-full-0-1700000000000",
  repo: "/run",
  scratch: "/run/tmp/issue-7",
} as const;

/** Temp roots this file created, for the calling case to clean up. */
export const disposables: string[] = [];

/** A scratch tree holding a session file the continuation can resume. */
export function scratch(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lean-continuation-"));
  disposables.push(dir);
  const file = join(dir, name);
  writeFileSync(file, '{"type":"user","message":"the fixer read this"}\n');
  return file;
}

/** The `agent_end` a fake child prints: one assistant turn, with what the case wants recorded. */
export function agentEnd(over: {
  text?: string;
  stopReason?: string;
  usage?: Record<string, unknown>;
}): unknown {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        ...(over.stopReason === undefined ? {} : { stopReason: over.stopReason }),
        content: [{ type: "text", text: over.text ?? "" }],
        ...(over.usage === undefined ? {} : { usage: over.usage }),
      },
    ],
  };
}

/** What a fake child was handed. */
export type Seen = {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
};

/** A child that answers one `agent_end` and exits — or exits the way the case says. */
export function child(
  events: unknown[],
  opts: {
    exitCode?: number;
    onSpawn?: (argv: string[], env: Record<string, string | undefined>, cwd?: string) => void;
  } = {},
): {
  spawn: typeof spawn;
  seen: () => Seen;
} {
  let seen: Seen = { argv: [], env: {} };
  return {
    seen: () => seen,
    spawn: ((
      _cmd: string,
      argv: string[],
      o?: { env?: Record<string, string | undefined>; cwd?: string },
    ) => {
      seen = { argv, env: o?.env ?? {}, cwd: o?.cwd };
      opts.onSpawn?.(argv, o?.env ?? {}, o?.cwd);
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      queueMicrotask(() => {
        for (const e of events)
          (stdout as unknown as { write: (s: string) => void }).write(`${JSON.stringify(e)}\n`);
        (stdout as unknown as { end: () => void }).end();
      });
      // The child reads its one prompt and then goes; `end()` on the caller's side is what lets it exit.
      stdin.on("data", () => undefined);
      const proc = {
        stdout,
        stderr: new PassThrough(),
        stdin,
        kill: () => true,
        on: (event: string, cb: (arg: never) => void) => {
          if (event === "exit") queueMicrotask(() => cb((opts.exitCode ?? 0) as never));
          return proc;
        },
      } as unknown as ChildProcessWithoutNullStreams;
      return proc;
    }) as typeof spawn,
  };
}
