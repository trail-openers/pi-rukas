/**
 * Permission decision cache: the persisted "Allow always" / "Deny always"
 * store backing the permission guard. Owns cache-key construction (bash exact
 * hash vs. wildcard-prefix pattern), decision-key classification/validation
 * for entries loaded from disk, bounded eviction, and read/write of
 * `$PWD/.pi/decisions.json`. Split out of permission-guard.ts (#171) to stay
 * under the module-size guideline (AGENTS.md §12).
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BASH_COMMAND_INJECTION_CHARS,
  extractCommandPrefix,
  stripQuotedSegments,
} from "./bash-command-parser.ts";
import type { PermissionRequest } from "./permission-broker.ts";
import { trace } from "./trace.js";

// Constants
const DECISION_KEY_MAX_ARGS = 200;
export const DECISION_KEY_MAX_LENGTH = 250;
export const MAX_CACHED_DECISIONS = 500;

// Pattern key constants for bash command prefix caching
const BASH_PATTERN_PREFIX = "bash:";
const PATTERN_SUFFIX = " *";
// Chars that should NEVER appear in a stored bash *pattern prefix*. A prefix
// like `vipune add` is safe; one like `vipune "add` or `vipune *` is not — at
// match time it would either fail to compare correctly or could match unexpected
// commands. Used by isSafeBashPatternPrefix to gate what we save to disk.
const BASH_PATTERN_UNSAFE_CHARS = /['"`*?\[\]{}|&;<>$]/;

// Pattern key helpers
function buildPatternKey(prefix: string): string {
  return `${BASH_PATTERN_PREFIX}${prefix}${PATTERN_SUFFIX}`;
}
function isPatternKey(key: string): boolean {
  return key.startsWith(BASH_PATTERN_PREFIX) && key.endsWith(PATTERN_SUFFIX);
}
export function extractPatternPrefix(key: string): string {
  return key.slice(BASH_PATTERN_PREFIX.length, -PATTERN_SUFFIX.length);
}

function isSafeBashPatternPrefix(prefix: string): boolean {
  return prefix.length > 0 && !BASH_PATTERN_UNSAFE_CHARS.test(prefix);
}

export function getBashAlwaysScope(command: string): string | null {
  if (command.trim().length === 0) return null;
  // Commands with injection vectors (`&&`, `$(...)`, backticks, redirects, etc.)
  // OUTSIDE quoted segments can't be safely wildcarded — what we'd cache as
  // `cmd *` would also match benign invocations that contain the same
  // injection at runtime. Quoted content is exempt (see stripQuotedSegments).
  if (BASH_COMMAND_INJECTION_CHARS.test(stripQuotedSegments(command))) return null;
  const prefix = extractCommandPrefix(command);
  if (!isSafeBashPatternPrefix(prefix)) return null;
  return prefix;
}

export function getBashAlwaysPromptLabel(
  action: "Allow always" | "Deny always",
  command: string,
): string {
  const scope = getBashAlwaysScope(command);
  return scope ? `${action} (${scope} *)` : action;
}

export function buildExactBashDecisionKey(command: string): string {
  const digest = createHash("sha256").update(command, "utf8").digest("hex");
  return `${BASH_PATTERN_PREFIX}exact:${digest}`;
}

export function bashPatternMatches(command: string, scope: string): boolean {
  if (!isSafeBashPatternPrefix(scope)) return false;
  // Even if the prefix matches, refuse to honour a wildcard for commands that
  // contain injection vectors OUTSIDE quoted segments. Runtime mirror of the
  // check in getBashAlwaysScope — `$(...)` outside quotes can't be auto-
  // approved by any wildcard, only by explicit "Allow once" decision.
  if (BASH_COMMAND_INJECTION_CHARS.test(stripQuotedSegments(command))) return false;
  const matchesPrefix =
    command.startsWith(scope) && (command.length === scope.length || command[scope.length] === " ");
  if (!matchesPrefix) return false;
  return extractCommandPrefix(command) === scope;
}

export function isSafeBashPatternKey(key: string): boolean {
  if (!isPatternKey(key)) return false;
  return isSafeBashPatternPrefix(extractPatternPrefix(key));
}

export function getBashDecisionCacheKey(command: string, input: unknown): string {
  const scope = getBashAlwaysScope(command);
  return scope ? buildPatternKey(scope) : buildExactBashDecisionKey(command);
}

// Helper: evict oldest entries from a decisions map
export function evictOldest(
  map: Map<string, { allowed: boolean; timestamp: string }>,
  max: number,
): void {
  if (map.size <= max) return;
  const sorted = [...map.entries()].sort((a, b) => b[1].timestamp.localeCompare(a[1].timestamp));
  map.clear();
  for (const [k, v] of sorted.slice(0, max)) map.set(k, v);
}

// Tool names that have been removed from pi-ensemble but may still appear in
// older `.pi/decisions.json` files. Loading them is harmless but they bloat
// the cache and confuse `/runs`-style introspection. Add a tool here when it
// is removed; entries here are cleaned out of the cache on session_start.
const STALE_TOOL_NAMES = new Set(["pair_watch"]);

// Decision keys we accept come in three shapes (see save sites):
//   1. `bash:<prefix> *`         — bash wildcard pattern (from "Allow always")
//   2. `bash:exact:<sha256>`     — bash exact-command hash (injection-vector
//                                  commands that the user "Allow always"-ed)
//   3. `<toolname>`              — non-bash tool-level grant (no ":" at all)
//
// Anything else came from an earlier version of the code that keyed decisions
// on a JSON.stringify(input). Those entries are tied to a literal input string
// and will never match a future invocation — drop them.
type DecisionKeyShape =
  | "bash-pattern"
  | "bash-exact"
  | "tool-level"
  | "old-format-full-input"
  | "unsafe-pattern"
  | "stale-tool"
  | "invalid";

function classifyDecisionKey(key: string): DecisionKeyShape {
  if (key.length === 0) return "invalid";
  if (key.startsWith(BASH_PATTERN_PREFIX)) {
    if (key.startsWith(`${BASH_PATTERN_PREFIX}exact:`)) return "bash-exact";
    if (isPatternKey(key)) {
      return isSafeBashPatternKey(key) ? "bash-pattern" : "unsafe-pattern";
    }
    // Starts with `bash:` but neither `exact:` nor ends with ` *` → must be the
    // old `bash:{"command":"..."}` JSON-input shape.
    return "old-format-full-input";
  }
  if (!key.includes(":")) {
    // Tool-name level (e.g. `dispatch_specialist`). Reject if the tool no
    // longer exists.
    if (STALE_TOOL_NAMES.has(key)) return "stale-tool";
    // Reject obviously malformed entries (whitespace, control chars, etc.).
    if (!/^[A-Za-z0-9_.\-]+$/.test(key)) return "invalid";
    return "tool-level";
  }
  // Has ":" but doesn't start with "bash:" → old-format `<toolname>:{...}` shape.
  const prefix = key.slice(0, key.indexOf(":"));
  if (STALE_TOOL_NAMES.has(prefix)) return "stale-tool";
  return "old-format-full-input";
}

export function decisionKey(toolName: string, args: unknown): string {
  try {
    return `${toolName}:${JSON.stringify(args ?? {}).slice(0, DECISION_KEY_MAX_ARGS)}`;
  } catch (err) {
    trace(`permission-guard: JSON.stringify args failed (${err}), falling back to type-only`);
  }
  try {
    return `${toolName}:${JSON.stringify({ type: typeof args }).slice(0, DECISION_KEY_MAX_ARGS)}`;
  } catch (err) {
    trace(`permission-guard: JSON.stringify fallback failed (${err}), using generic key`);
  }
  return `${toolName}:unknown`;
  // NOTE: This serializes entire args before truncating. Acceptable for typical tool args (<1KB).
  // Do NOT add custom replacer — over-engineering for this use case.
}

export function persistDecisions(
  decisionsMap: Map<string, { allowed: boolean; timestamp: string }>,
): void {
  const piDir = path.join(process.cwd(), ".pi");
  const decisionsPath = path.join(piDir, "decisions.json");
  const tmpPath = `${decisionsPath}.tmp`;

  try {
    // Ensure .pi/ exists with secure permissions in one call
    mkdirSync(piDir, { recursive: true, mode: 0o700 });

    // Evict oldest entries if over limit
    evictOldest(decisionsMap, MAX_CACHED_DECISIONS);

    // NOTE: writeFileSync blocks the event loop. Acceptable for now: decision writes are
    // <50KB and happen only on "always" choices (not every tool call). Do NOT refactor to async.
    const obj = Object.fromEntries(decisionsMap.entries());
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
    renameSync(tmpPath, decisionsPath);

    // Belt-and-braces chmod: log failure instead of silent catch
    try {
      chmodSync(decisionsPath, 0o600);
    } catch (err) {
      trace(
        `pi-ensemble permission-guard: chmod ${decisionsPath} failed (${err}) — file may have incorrect permissions`,
      );
    }
  } catch (err) {
    const msg = `pi-ensemble permission-guard: failed to persist decisions (${err})`;
    console.warn(msg);
    trace(msg);

    // Clean up .tmp file if it exists (best-effort)
    try {
      // Use dynamic require to avoid importing fs at top level
      const fs = require("node:fs");
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Cleanup failure is acceptable — .tmp will be ignored next write
    }

    // Return without crashing
    return;
  }
}

// Load decisions persisted to `decisionsPath` (normally
// `$PWD/.pi/decisions.json`) into `decisions`, classifying and dropping
// malformed / stale / old-format entries. Called from permission-guard.ts's
// `session_start` handler — lifted out here because the whole body is decision-
// cache validation logic with no Pi API surface of its own.
export function loadPersistedDecisions(
  decisionsPath: string,
  decisions: Map<string, { allowed: boolean; timestamp: string }>,
): void {
  try {
    const raw = readFileSync(decisionsPath, "utf8");
    const parsed = JSON.parse(raw);
    let loaded = 0;
    let droppedMalformed = 0;
    let droppedStale = 0;
    let droppedOldFormat = 0;
    for (const [key, val] of Object.entries(parsed)) {
      if (key.length > DECISION_KEY_MAX_LENGTH) {
        trace(
          `pi-ensemble permission-guard: skipping over-length decision key: ${key.slice(0, 50)}...`,
        );
        droppedMalformed++;
        continue;
      }
      const shape = classifyDecisionKey(key);
      if (shape === "stale-tool") {
        trace(`pi-ensemble permission-guard: dropping stale tool decision: ${key}`);
        droppedStale++;
        continue;
      }
      if (shape === "old-format-full-input") {
        // Old-format full-input keys (`bash:{"command":"..."}`, `dispatch_specialist:{"cwd":...}`)
        // are tied to a literal input string. They never match a future
        // invocation that differs by a single character — dead weight that
        // bloats the cache without providing matches.
        trace(`pi-ensemble permission-guard: dropping old-format decision: ${key.slice(0, 50)}`);
        droppedOldFormat++;
        continue;
      }
      if (shape === "unsafe-pattern") {
        trace(
          `pi-ensemble permission-guard: skipping unsafe bash wildcard decision key: ${key.slice(0, 50)}...`,
        );
        droppedMalformed++;
        continue;
      }
      if (shape === "invalid") {
        trace(`pi-ensemble permission-guard: skipping invalid decision key: ${key.slice(0, 50)}`);
        droppedMalformed++;
        continue;
      }
      // Validate entry shape BEFORE casting
      if (val === null || typeof val !== "object") {
        trace(`permission-guard: skipping malformed decision for key: ${key.slice(0, 50)}`);
        droppedMalformed++;
        continue;
      }
      const entry = val as Record<string, unknown>;
      if (
        typeof entry.allowed !== "boolean" ||
        typeof entry.timestamp !== "string" ||
        entry.timestamp.length > 50
      ) {
        trace(`permission-guard: skipping malformed decision for key: ${key.slice(0, 50)}`);
        droppedMalformed++;
        continue;
      }
      decisions.set(key, { allowed: entry.allowed, timestamp: entry.timestamp });
      loaded++;
    }
    const dropped = droppedMalformed + droppedStale + droppedOldFormat;
    if (dropped > 0) {
      // Persist the cleaned cache so the next session sees a tidy file and
      // we don't repeatedly re-evaluate the same stale entries.
      persistDecisions(decisions);
      console.info(
        `pi-ensemble permission-guard: loaded ${loaded} decisions; dropped ${dropped} (` +
          `${droppedMalformed} malformed, ${droppedOldFormat} old-format, ${droppedStale} stale-tool)`,
      );
    } else {
      trace(`permission-guard: loaded ${loaded} cached decisions`);
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT") {
        // Missing file is normal on first run — silent
        return;
      }
      if (code === "EACCES") {
        const msg = `pi-ensemble permission-guard: cannot read decisions file (${err})`;
        console.warn(msg);
        return;
      }
    }
    if (err instanceof SyntaxError) {
      const msg = `pi-ensemble permission-guard: decisions file is not valid JSON (${err.message})`;
      console.warn(msg);
      return;
    }
    // Other errors: trace for debugging
    trace(`pi-ensemble permission-guard: error loading decisions (${err})`);
  }
}

// Broker-deps cache lookup/write, shared by registerPermissionGuard's
// brokerDepsFactory closure. Pure decisions-map logic — no Pi API surface —
// lifted out here to match the cachedLookup/persistDecision shape the
// subagent-permission broker (permission-broker.ts) expects.
export function lookupCachedBrokerDecision(
  decisions: Map<string, { allowed: boolean; timestamp: string }>,
  req: PermissionRequest,
): boolean | undefined {
  // Match the lookup shape the parent tool_call handler uses so subagent-
  // escalated decisions hit the same cache entries.
  const isBash = req.toolName === "bash" && req.bashCommand !== undefined;
  const bashCmd = isBash ? (req.bashCommand ?? "") : "";
  const bashAlwaysScope = isBash ? getBashAlwaysScope(bashCmd) : null;
  const exactKey =
    isBash && bashAlwaysScope === null
      ? buildExactBashDecisionKey(bashCmd)
      : isBash
        ? buildPatternKey(bashAlwaysScope as string)
        : req.toolName;
  const exact = decisions.get(exactKey);
  if (exact) return exact.allowed;
  // For bash, also check pattern matches (Allow always with a prefix).
  if (isBash) {
    for (const [patternKey, decision] of decisions) {
      if (!isSafeBashPatternKey(patternKey)) continue;
      const prefix = extractPatternPrefix(patternKey);
      if (bashPatternMatches(bashCmd, prefix)) return decision.allowed;
    }
  }
  return undefined;
}

export function persistCachedBrokerDecision(
  decisions: Map<string, { allowed: boolean; timestamp: string }>,
  req: PermissionRequest,
  allowed: boolean,
): void {
  const isBash = req.toolName === "bash" && req.bashCommand !== undefined;
  const bashCmd = isBash ? (req.bashCommand ?? "") : "";
  const cacheKey = isBash ? getBashDecisionCacheKey(bashCmd, undefined) : req.toolName;
  decisions.set(cacheKey, { allowed, timestamp: new Date().toISOString() });
  evictOldest(decisions, MAX_CACHED_DECISIONS);
  persistDecisions(decisions);
}

/**
 * Parent-guard cached-decision lookup for the `tool_call` handler: exact
 * match first, then bash pattern ("always") matches, then non-bash
 * tool-name-level cache. Returns `undefined` on a cache miss (caller falls
 * through to the verdict-resolution path); otherwise the cached
 * allow/deny plus a ready-to-use denial reason.
 */
export function lookupCachedToolDecision(
  decisions: Map<string, { allowed: boolean; timestamp: string }>,
  toolName: string,
  command: string,
  input: unknown,
): { allowed: boolean; reason: string } | undefined {
  const bashAlwaysScope = toolName === "bash" ? getBashAlwaysScope(command) : null;
  const key =
    toolName === "bash" && bashAlwaysScope === null
      ? buildExactBashDecisionKey(command)
      : decisionKey(toolName, input);
  const cached = decisions.get(key);
  if (cached !== undefined) {
    return {
      allowed: cached.allowed,
      reason: `Tool '${toolName}' denied (cached decision)`,
    };
  }

  if (toolName === "bash") {
    for (const [patternKey, decision] of decisions) {
      if (!isSafeBashPatternKey(patternKey)) continue;
      const prefix = extractPatternPrefix(patternKey);
      if (bashPatternMatches(command, prefix)) {
        return {
          allowed: decision.allowed,
          reason: `Tool 'bash' denied (cached pattern: ${prefix} *)`,
        };
      }
    }
  }

  if (toolName !== "bash") {
    const toolLevelCached = decisions.get(toolName);
    if (toolLevelCached !== undefined) {
      return {
        allowed: toolLevelCached.allowed,
        reason: `Tool '${toolName}' denied (cached decision)`,
      };
    }
  }

  return undefined;
}
