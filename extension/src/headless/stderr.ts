/**
 * headless/stderr — keep the runner's stderr NDJSON-only (#1370).
 *
 * The driver writes plain-text diagnostics from many places: `trace` /
 * `traceWarn` (`process.stderr.write`), and `console.*` (the PATH fallback
 * warning in pi-binary-resolve, among others). In a headless run those would
 * break a strict NDJSON reader on the first line. `captureStrayOutput`
 * reroutes both channels for the duration of a run: every line becomes a
 * `log` line, with `level: "warn"` for warnings. `console.log` / `info` /
 * `debug` are rerouted too, so stdout carries only the runner's own summary
 * or `--json` document.
 *
 * The NDJSON writer the runner uses is the original stderr write, returned as
 * `write`, so its own lines pass through untouched. Output of a child process
 * that shares the runner's stderr file descriptor is not seen here; nothing
 * in the driver spawns with an inherited stderr.
 */

import { format } from "node:util";
import type { LineWriter } from "./host.ts";
import { formatLine } from "./ndjson.ts";

export type LogLevel = "info" | "warn";

export interface StderrCapture {
  /** The original stderr writer: one NDJSON line per call (newline added). */
  write: LineWriter;
  /** Emit any unterminated text as a final line. Call before process.exit. */
  flush: () => void;
  /** Flush, then put process.stderr.write and console.* back. */
  restore: () => void;
}

/** The level a plain-text stderr line carries: `traceWarn` and WARNING lines are warnings. */
export function levelOf(line: string): LogLevel {
  return /^\[pi-rukas\] (WARN\b|.*\bWARNING\b)/.test(line) ? "warn" : "info";
}

/** One stray line as an NDJSON `log` line. */
export function strayLine(message: string, level: LogLevel, at = new Date()): string {
  return formatLine({
    v: 1,
    kind: "log",
    at: at.toISOString(),
    message,
    ...(level === "warn" ? { level } : {}),
  });
}

type ConsoleMethod = "log" | "info" | "debug" | "warn" | "error";
const CONSOLE_LEVELS: Record<ConsoleMethod, LogLevel> = {
  log: "info",
  info: "info",
  debug: "info",
  warn: "warn",
  error: "warn",
};

/** Reroute process.stderr.write and console.* to NDJSON `log` lines. */
export function captureStrayOutput(): StderrCapture {
  const stderr = process.stderr;
  const original = stderr.write;
  const raw = (s: string) => original.call(stderr, s);
  const savedConsole = Object.fromEntries(
    (Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]).map((m) => [m, console[m]]),
  ) as Record<ConsoleMethod, (...a: unknown[]) => void>;
  let pending = "";

  const emit = (message: string, level: LogLevel) => {
    if (message.trim() === "") return;
    raw(`${strayLine(message, level)}\n`);
  };
  const flush = () => {
    if (pending === "") return;
    const rest = pending;
    pending = "";
    emit(rest, levelOf(rest));
  };

  stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);
    const lines = (pending + text).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) emit(line, levelOf(line));
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    cb?.();
    return true;
  }) as typeof stderr.write;

  for (const m of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    console[m] = (...args: unknown[]) => {
      // One console call is one message, even when it spans lines.
      emit(format(...args), CONSOLE_LEVELS[m]);
    };
  }

  return {
    write: (line) => raw(`${line}\n`),
    flush,
    restore: () => {
      flush();
      stderr.write = original;
      Object.assign(console, savedConsole);
    },
  };
}
