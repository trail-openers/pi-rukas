/**
 * lib/forge-read-auth-fixture — the socket transport the #2160 adversarial-round-1
 * tests drive, shared so the two case files cannot disagree about what "a foreign
 * listener on the path" means.
 *
 * `startForeign` is the attack itself: a process that knows the socket PATH but
 * not the per-child SECRET, listening where a child was told to dial. It records
 * every request line it received — which is what lets a case assert what the
 * child actually put on the wire — and answers with whatever the case hands it,
 * shaped like a parent's reply or not.
 *
 * `callChildTool` drives the child's REAL registered tool rather than the
 * transport directly, so a case sees exactly what the model would see: the tool
 * result's text and details. Env goes in and comes out around it, so a pinned
 * `PI_ENSEMBLE_FORGE_READ_*` pair cannot leak into the next case.
 *
 * The role is part of that env and never ambient. Registration is gated on
 * `PI_ENSEMBLE_ROLE` (`registerChildForgeReadTool` reads it out of the process
 * env and applies the same predicate activation does), so a case that pinned
 * only the broker pair would register nothing at all whenever the process
 * running the suite happened to carry a role — which is the normal state inside
 * a pi-rukas session and inside any parent that spawned the gate. The tool then
 * answers "no forge_read registered" and every refusal a case meant to observe
 * is silently replaced by "the tool was never there": a red case that blames
 * the machine instead of the code. `childEnv` is therefore the ONLY way a case
 * gets a role into the child; it defaults to a helper role and always writes an
 * explicit value, so the suite's verdict does not depend on who ran it.
 */

import { createConnection, createServer } from "node:net";
import {
  FORGE_READ_SECRET_ENV,
  FORGE_READ_SOCKET_ENV,
  registerChildForgeReadTool,
} from "../../src/child-forge-read-activation.ts";

/** A role-bearing child env carrying the pair this parent bound. */
export const pair = (socket: string, secret: string): Record<string, string> =>
  childEnv({ [FORGE_READ_SOCKET_ENV]: socket, [FORGE_READ_SECRET_ENV]: secret });

/**
 * A child env for a helper role, with `extra` merged on top.
 *
 * The `PI_ENSEMBLE_ROLE` entry is written explicitly rather than left to the
 * environment: an empty/whitespace role is not a helper (the production
 * predicate refuses it), and an ambient one is whatever the runner's parent
 * happened to set. A case that wants a different role (ops, no role at all)
 * overrides the entry in `extra`, or deletes it by passing `undefined`.
 */
export const childEnv = (
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  PI_ENSEMBLE_ROLE: "developer",
  ...extra,
});

export interface Foreign {
  socketPath: string;
  /** Request lines this listener actually received, in order. */
  received: string[];
  stop(): void;
}

/**
 * Listen on `socketPath` (or a fresh private path) and answer every request line
 * with `reply` — an object, or a function of the line, so a case can build its
 * forgery out of what the child sent.
 */
export async function startForeign(
  reply: unknown | ((line: string) => unknown),
  socketPath?: string,
): Promise<Foreign> {
  const received: string[] = [];
  const server = createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      received.push(line);
      const body = typeof reply === "function" ? reply(line) : reply;
      conn.write(`${JSON.stringify(body)}\n`);
    });
  });
  const path = socketPath ?? (await freeSocketPath("foreign"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return {
    socketPath: path,
    received,
    stop: () => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** A path in a private temp dir that nothing is listening on (until we bind it). */
export async function freeSocketPath(tag: string): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/forge-auth-${tag}-`);
  return `${dir}/broker.sock`;
}

/**
 * Drive the child's real `forge_read` handler under `env` and return what the
 * model would see. Returns a marker text when the tool was never registered, so
 * a case asserting "no tool" and a case asserting "a refusal" cannot be confused.
 */
export async function callChildTool(
  env: Record<string, string | undefined>,
  args: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
  const saved = { ...process.env };
  const registered: Array<{
    name: string;
    execute: (
      id: string,
      raw: unknown,
    ) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
  }> = [];
  const pi = { registerTool: (t: (typeof registered)[number]) => registered.push(t) };
  try {
    for (const k of [FORGE_READ_SOCKET_ENV, FORGE_READ_SECRET_ENV]) delete process.env[k];
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    registerChildForgeReadTool(pi as never);
    const tool = registered.find((t) => t.name === "forge_read");
    if (!tool) return { text: "<no forge_read registered>", details: { registered: false } };
    const res = await tool.execute("call-1", args);
    return { text: res.content.map((c) => c.text).join(""), details: res.details };
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** One raw JSON line to a socket, returning the raw reply line (undefined if none). */
export function askRaw(socketPath: string, line: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath, () => conn.write(line));
    let buf = "";
    let settled = false;
    const finish = (v: string | undefined): void => {
      if (settled) return;
      settled = true;
      conn.destroy();
      resolve(v);
    };
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish(buf.slice(0, nl));
    });
    conn.on("close", () => finish(undefined));
    conn.on("error", reject);
    const t = setTimeout(() => finish(undefined), 5000);
    t.unref();
  });
}

/** Run `fn` with the trace channel captured (and enabled), returning its result. */
export async function withTrace<T>(sink: string[] | undefined, fn: () => Promise<T>): Promise<T> {
  const savedDebug = process.env.PI_ENSEMBLE_DEBUG;
  const savedWrite = process.stderr.write;
  process.env.PI_ENSEMBLE_DEBUG = "1";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    sink?.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stderr.write = savedWrite;
    if (savedDebug === undefined) delete process.env.PI_ENSEMBLE_DEBUG;
    else process.env.PI_ENSEMBLE_DEBUG = savedDebug;
  }
}
