/**
 * public-denylist — the reader and matcher behind the public-repository
 * hygiene guard (#1788).
 *
 * This repository is public, and agent-written issues, PR bodies, comments,
 * fixtures and commit messages carried private host names, private project
 * names and personal paths. AGENTS.md's "Public repository hygiene" section is
 * the prose rule; `public-hygiene-guard.ts` is the enforcement; this file is
 * the operator's list of terms and the small generic set that applies when no
 * list exists.
 *
 * ## Where the list lives, and why outside the repo
 *
 * `~/.config/pi-rukas/public-denylist` (overridable with
 * `PI_ENSEMBLE_PUBLIC_DENYLIST`), the same out-of-repo config idiom as
 * `memory-stats.ts`'s `defaultDbPath`. A file inside the repository cannot
 * hold the terms it exists to keep out of the repository.
 *
 * ## The term never travels
 *
 * Every result of this module names a LINE NUMBER or a CATEGORY, never the
 * matched text — in the return value, in the refusal `public-hygiene-guard.ts`
 * renders, and in every trace line. A refusal that quotes the term would put
 * the secret in the place the guard exists to protect. This is the
 * `memory-write-guard.ts` precedent ("never the command text, which is
 * untrusted and may hold secrets") applied to a stronger case: here the text
 * IS the secret.
 *
 * ## Three states, because "absent" and "unreadable" are different rules
 *
 * - `absent` (ENOENT) — the operator has no list. The GENERIC set still
 *   applies; a missing file is not a fault.
 * - `unreadable` — anything else (EACCES, EIO, a directory, a file over
 *   `MAX_DENYLIST_BYTES`). A configured list nobody could read must not read
 *   as "no list", because that would let a permission slip disable the
 *   private check while the guard kept reporting itself as working. The
 *   caller refuses.
 * - `ok` — the entries, with their source line numbers.
 *
 * ## Reload
 *
 * The file is stat'd on every check and re-read when its mtime or size
 * changed, so an operator who edits the list is obeyed on the next call and
 * deleting it falls back to the generic set. The stats are taken BEFORE the
 * read and re-taken after it, so a write that lands mid-read does not leave
 * the cache holding bytes nobody observed — the next call re-reads.
 *
 * ## Regex entries are operator text compiled into the tool_call path
 *
 * A line `regex:<pattern>` compiles to a JS RegExp with the `i` flag. Two
 * bounds, both aimed at the cost of a bad pattern rather than its meaning:
 * an invalid one is skipped with a trace naming its LINE NUMBER ONLY, and
 * every test runs against slices of at most `REGEX_SLICE_BYTES`, so a
 * catastrophic-backtracking pattern cannot hang a single tool_call on an
 * unbounded body. This repo already treats operator regexes as an attack
 * surface (`secret-patterns.ts` #1393, `test-decision-secret-regex-linear.ts`).
 */

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { traceWarn } from "./trace.ts";

/** The env var naming the file (the `memory-stats.ts` `VIPUNE_DB_PATH` idiom). */
export const PUBLIC_DENYLIST_PATH_ENV = "PI_ENSEMBLE_PUBLIC_DENYLIST";

/** The operator's file, when no env override is set. */
export const PUBLIC_DENYLIST_DEFAULT_PATH = path.join(
  os.homedir(),
  ".config",
  "pi-rukas",
  "public-denylist",
);

/** Refuse to read a list this large — it is not a list any more, it is a dump. */
export const MAX_DENYLIST_BYTES = 1024 * 1024;

/** Text handed to one regex test. Bounds the cost of an operator-written pattern. */
export const REGEX_SLICE_BYTES = 64 * 1024;

/** The prefix that makes a line a regular expression rather than a literal. */
export const REGEX_PREFIX = "regex:";

/** `~/.config/pi-rukas/public-denylist`, or the override in the env. */
export function publicDenylistPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[PUBLIC_DENYLIST_PATH_ENV]?.trim();
  return fromEnv ? fromEnv : PUBLIC_DENYLIST_DEFAULT_PATH;
}

/** One compiled entry. `line` is its 1-based line number in the file. */
export interface DenylistEntry {
  line: number;
  kind: "literal" | "regex";
  /** Bounded substring test for a literal, bounded per-slice test for a regex. */
  test: (text: string) => boolean;
}

/** What reading the list produced. See the module header for the three states. */
export type DenylistRead =
  | { state: "absent" }
  | { state: "unreadable"; reason: string }
  | { state: "ok"; entries: DenylistEntry[] };

/** A match: which line of the operator's file answered, never what it said. */
export interface DenylistMatch {
  line: number;
}

/** The small set of shapes that are private whatever the operator's file says. */
export type GenericCategory = "private-ipv4" | "home-path";

/**
 * Private IPv4 ranges: 10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT).
 *
 * RFC 5737's documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24)
 * are EXCLUDED — they exist for exactly the example text this project's tests
 * and docs write, so a guard that refused them would train everyone to switch
 * the guard off. Loopback is excluded for the same reason it is not private:
 * 127.0.0.1 names no infrastructure.
 *
 * The scanner below finds EVERY dotted quad and the CIDR table decides
 * whether it is private, so a range is written once as a prefix and a length
 * rather than as an octet alternation. The 100.64/10 range alone is 64 /16s:
 * spelled out, it is a list a reviewer has to count, and a miscounted entry is
 * a silent hole in the only check between a private address and a public repo.
 */
const IPV4_QUAD = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;

/** The blocks that make an address private (issue decision 2). */
const PRIVATE_CIDR: ReadonlyArray<[string, number]> = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
];

/**
 * The blocks the scanner also finds which are NOT findings. Checked first, so
 * an address inside one of them is never `private-ipv4` whatever the table
 * below says — RFC 5737 exists so documentation can carry an example address.
 */
const NOT_PRIVATE_CIDR: ReadonlyArray<[string, number]> = [
  ["127.0.0.0", 8],
  ["192.0.2.0", 24],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
];

/** Dotted quad -> a 32-bit number, or undefined for anything that is not one. */
function ipv4ToInt(addr: string): number | undefined {
  const parts = addr.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    n = n * 256 + octet;
  }
  return n;
}

/** Is `n` one of the `2 ** (32 - bits)` addresses of `<base>/<bits>`? */
function inCidr(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === undefined) return false;
  const size = 2 ** (32 - bits);
  return n >= b && n < b + size;
}

/** Is this dotted quad inside a private block, and not inside an exempt one? */
function isPrivateIpv4(addr: string): boolean {
  const n = ipv4ToInt(addr);
  if (n === undefined) return false;
  for (const [base, bits] of NOT_PRIVATE_CIDR) if (inCidr(n, base, bits)) return false;
  for (const [base, bits] of PRIVATE_CIDR) if (inCidr(n, base, bits)) return true;
  return false;
}

/** A 24-hour clock time (`10.1:30`) — a time, not an address. */
const CLOCK_TIME = /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?$/;

/**
 * The generic set's address rule. Returns the category for a piece of text,
 * or undefined. Applies to PUBLIC TEXT only — never to a code diff, where a
 * test fixture legitimately carries an example address (the two-tier split the
 * issue's acceptance criteria pin in both directions).
 */
export function genericCategoryOf(text: string): GenericCategory | undefined {
  if (HOME_PATH.test(withoutEmailTokens(text))) return "home-path";
  if (!text.includes(".")) return undefined;
  IPV4_QUAD.lastIndex = 0;
  for (const m of text.matchAll(IPV4_QUAD)) {
    if (CLOCK_TIME.test(m[0] as string)) continue;
    if (isPrivateIpv4(m[0] as string)) return "private-ipv4";
  }
  return undefined;
}

/**
 * An absolute home directory, outside the email token it sits in. The rule is
 * asked of the text with each email address blanked out rather than of the
 * whole string: a bare `if (text.includes("@")) return undefined` let any
 * address anywhere in a body switch the path rule off for the entire text, so
 * one "contact us at ops@example.invalid" excused a `/home/alice/…` two
 * sentences later. The address itself is exempt (its host part legitimately
 * looks like a host), nothing else is.
 */
const EMAIL_TOKEN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Every email address in `text`, replaced by a neutral placeholder. */
function withoutEmailTokens(text: string): string {
  return text.replace(EMAIL_TOKEN, " email ");
}

/**
 * Absolute home directories. `/home/alice/` and `/Users/alice/` name a person;
 * `dev`, `user`, `example`, `ops` and `runner` are placeholders that appear in
 * every project's docs and fixtures and name nobody, so they pass. A mail
 * address (`user@host`) is not a path — `withoutEmailTokens` is what keeps it
 * out of this rule without silencing the rule for the rest of the text.
 */
const HOME_PATH =
  /(?:^|[^\w./~-])(?:\/(?:home|Users)\/(?!dev\/|user\/|example\/|ops\/|runner\/)\w+\/?)/;

/** The first entry whose test matches, or undefined. Never returns the term. */
export function matchDenylist(
  entries: readonly DenylistEntry[],
  text: string,
): DenylistMatch | undefined {
  if (entries.length === 0 || text === "") return undefined;
  for (const entry of entries) {
    if (entry.test(text)) return { line: entry.line };
  }
  return undefined;
}

/** Compile one entry. A regex that does not compile returns undefined (skipped). */
function compileEntry(lineNumber: number, raw: string): DenylistEntry | undefined {
  const body = raw.trim();
  if (body === "") return undefined;
  if (!body.toLowerCase().startsWith(REGEX_PREFIX)) {
    const needle = body.toLowerCase();
    return {
      line: lineNumber,
      kind: "literal",
      test: (text: string) => text.toLowerCase().includes(needle),
    };
  }
  const pattern = body.slice(REGEX_PREFIX.length).trim();
  if (pattern === "") return undefined;
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    // The line number is the most this may say: the pattern text is operator
    // content and a trace line reaches the run transcript.
    traceWarn(`public-hygiene: skipped invalid regex denylist entry at line ${lineNumber}`);
    return undefined;
  }
  if (re.test("")) {
    // A pattern that matches the empty string matches every command, which
    // would refuse every publish in the session. Not what a list entry means.
    traceWarn(`public-hygiene: skipped empty-matching regex denylist entry at line ${lineNumber}`);
    return undefined;
  }
  return { line: lineNumber, kind: "regex", test: (text: string) => testRegexBounded(re, text) };
}

/** `re` against slices of at most REGEX_SLICE_BYTES, so one test is bounded. */
function testRegexBounded(re: RegExp, text: string): boolean {
  if (!re.global && !re.sticky) {
    for (let start = 0; start < text.length; start += REGEX_SLICE_BYTES) {
      if (re.test(text.slice(start, start + REGEX_SLICE_BYTES))) return true;
    }
    return false;
  }
  // A global/sticky regex carries lastIndex, so each slice gets its own copy.
  for (let start = 0; start < text.length; start += REGEX_SLICE_BYTES) {
    const per = new RegExp(re.source, re.flags);
    if (per.test(text.slice(start, start + REGEX_SLICE_BYTES))) return true;
  }
  return false;
}

/** Parse file content into entries. `#` comments and blank lines are ignored. */
export function parseDenylist(raw: string): DenylistEntry[] {
  const entries: DenylistEntry[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const entry = compileEntry(i + 1, line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** The cached read, keyed on the path plus the mtime/size identity that produced it. */
interface DenylistCache {
  path: string;
  mtimeMs: number;
  size: number;
  result: DenylistRead;
}

let cache: DenylistCache | undefined;

/** Drop the cache. Tests use it to prove a mid-session edit takes effect. */
export function resetDenylistCacheForTests(): void {
  cache = undefined;
}

/**
 * Read the operator's denylist. Call this on every check: the file is stat'd
 * and re-read only when its mtime or size changed (see the module header).
 *
 * `absent` and `ok` are both "no problem"; `unreadable` is the state the caller
 * must refuse on, because a configured list nobody could read is not a list.
 */
export function readPublicDenylist(env: NodeJS.ProcessEnv = process.env): DenylistRead {
  const file = publicDenylistPath(env);
  let before: ReturnType<typeof statSync>;
  try {
    before = statSync(file);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      cache = undefined;
      return { state: "absent" };
    }
    return { state: "unreadable", reason: `the denylist could not be read (${codeOf(err)})` };
  }
  if (!before.isFile()) {
    return { state: "unreadable", reason: "the denylist path is not a regular file" };
  }
  if (before.size > MAX_DENYLIST_BYTES) {
    return {
      state: "unreadable",
      reason: `the denylist is larger than ${MAX_DENYLIST_BYTES} bytes`,
    };
  }
  const current = cache;
  if (
    current &&
    current.path === file &&
    current.mtimeMs === before.mtimeMs &&
    current.size === before.size &&
    current.result.state === "ok"
  ) {
    return current.result;
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: `the denylist could not be read (${codeOf(err)})` };
  }
  // The size bound is asked of the bytes we actually read too: a file that
  // grew between the stat and the read is oversized whatever the stat said.
  if (Buffer.byteLength(raw, "utf8") > MAX_DENYLIST_BYTES) {
    return {
      state: "unreadable",
      reason: `the denylist is larger than ${MAX_DENYLIST_BYTES} bytes`,
    };
  }
  let after: ReturnType<typeof statSync> | undefined;
  try {
    after = statSync(file);
  } catch {
    after = undefined; // deleted after the read: the content we hold is what was there
  }
  const result: DenylistRead = { state: "ok", entries: parseDenylist(raw) };
  cache = after?.isFile()
    ? { path: file, mtimeMs: after.mtimeMs, size: after.size, result }
    : undefined;
  return result;
}

/** An exec/fs error's `code`, for a refusal that names why without quoting it. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? code : "unknown error";
}

/**
 * Whether ANY public text is dirty: the operator's entries first, then the
 * generic set. Returns what to name in the refusal, never what matched.
 *
 * `applyGeneric` is false for code diffs, where the generic set is deliberately
 * out of scope (issue decision: the push scan is private-denylist-only).
 */
export function publicTextProblem(
  text: string,
  deny: DenylistRead,
  applyGeneric = true,
): PublicTextHit | undefined {
  if (text === "") return undefined;
  if (deny.state === "unreadable") return { kind: "unreadable", reason: deny.reason };
  if (deny.state === "ok") {
    const hit = matchDenylist(deny.entries, text);
    if (hit) return { kind: "denylist", line: hit.line };
  }
  if (!applyGeneric) return undefined;
  const category = genericCategoryOf(text);
  return category ? { kind: "generic", category } : undefined;
}

/** What the text check found. Each arm names what a refusal may legally say. */
export type PublicTextHit =
  | { kind: "denylist"; line: number }
  | { kind: "generic"; category: GenericCategory }
  | { kind: "unreadable"; reason: string };
