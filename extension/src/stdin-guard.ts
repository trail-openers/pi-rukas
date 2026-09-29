/**
 * stdin-guard — #932: the universal EPIPE backstop for child stdins.
 *
 * Node emits EPIPE on a pipe/socket ASYNCHRONOUSLY: `stdin.write(...)`
 * succeeds synchronously, the stream is destroyed, and an `error` event
 * fires on a later tick. With no `error` listener on the handle that
 * becomes an uncaughtException that terminates the whole pi process (the
 * 2026-09-29 incident: a slow-notice steer raced a dying child and killed
 * the PM session). A try/catch around `.write` can never catch this —
 * only a listener can.
 *
 * `attachStdinErrorGuard` must run IMMEDIATELY after the child is
 * spawned, BEFORE the handle is handed to the registry and before the
 * initial prompt write, so it covers every writer of the handle: the
 * kickoff prompt, `end()` in completePrompt, and every steerChild write.
 */
import type { Writable } from "node:stream";
import { trace } from "./trace.ts";

export function attachStdinErrorGuard(stdin: Writable, label: string): void {
  stdin.on("error", (err: Error) => {
    trace(`stdin-guard[${label}]: child stdin error (ignored): ${err.message}`);
  });
}
