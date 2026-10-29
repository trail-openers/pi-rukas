/**
 * The fence shapes the `pi-spec v1` renamer recognises, kept out of the module
 * under test so the renamer itself is a plain line-by-line loop with no regex.
 */
const SP = String.fromCharCode(32);
const TAB = String.fromCharCode(9);
const BT = String.fromCharCode(96);
const TI = String.fromCharCode(126);
const WS = SP + TAB + String.fromCharCode(11, 12, 13);

/** Leading spaces, at most 3 (CommonMark still reads the line as a fence). */
function fenceIndent(line: string): number {
  let n = 0;
  while (n < 3 && line[n] === SP) n++;
  return n;
}

/** The run of `c` starting at `at`, or "" when the line does not start a run. */
function fenceRunAt(line: string, at: number): string {
  const c = line[at];
  if (c !== BT && c !== TI) return "";
  let n = at;
  while (n < line.length && line[n] === c) n++;
  return line.slice(at, n);
}

/** True when everything after `at` is whitespace. */
function blankAfter(line: string, at: number): boolean {
  for (let i = at; i < line.length; i++) if (!WS.includes(line[i] as string)) return false;
  return true;
}

/** The info string of an opening fence line, trimmed; "" when it is not one. */
function openingFence(line: string): { run: string; indent: number; rest: string } | undefined {
  const indent = fenceIndent(line);
  const run = fenceRunAt(line, indent);
  if (run.length < 3) return undefined;
  return { run, indent, rest: line.slice(indent + run.length).trim() };
}

/** True when `line` closes a fence opened with `run` (same char, at least as long). */
export function closesFence(line: string, run: string): boolean {
  const f = openingFence(line);
  return (
    f !== undefined &&
    f.run.length >= run.length &&
    f.run[0] === run[0] &&
    blankAfter(line, f.indent + f.run.length)
  );
}

/** True when `line` is an opening fence whose info string is exactly `info`. */
export function opensFenceWith(line: string, info: string): boolean {
  const f = openingFence(line);
  return f !== undefined && f.rest === info;
}

/** An opening fence line's prefix up to and including its run, for rewriting. */
export function fencePrefix(line: string): string {
  const f = openingFence(line);
  return f === undefined ? line : line.slice(0, f.indent + f.run.length);
}

/** Any fence line opens a fence we must skip through; "" when it opens none. */
export function opensAnyFence(line: string): string {
  return openingFence(line)?.run ?? "";
}
