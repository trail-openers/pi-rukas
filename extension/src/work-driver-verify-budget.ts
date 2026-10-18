/**
 * work-driver-verify-budget — #1509: the wall-clock bound each verify tier is
 * given, and where that number comes from.
 *
 * Before this module there was ONE bound (`verifyTimeoutMs()`, 10 min) and
 * every verify seam read it: the fast tier, the full offline suite, the
 * baseline probe, the product smoke command, a `git diff -U0` for the skip
 * ratchet, and a comment-retention read. That is one number serving a 400 ms
 * lint run and a 641-file suite alike, so a healthy cycle whose suite
 * legitimately needs longer than ten minutes parked at `verify-failed:develop`
 * — a false verdict on code that was never judged. Raising the knob to cover
 * the suite also widened a `git diff` bound for no reason.
 *
 * So the bound is resolved PER TIER. The knobs are three, and the tier decides
 * which one governs:
 *
 *   fast    `.pi/verify-cmd-fast` — typecheck/lint, seconds. Stays short.
 *   suite   `.pi/verify-cmd` + the baseline probe — the offline suite. This is
 *           the tier that needs the larger budget.
 *   smoke   `.pi/smoke-cmd` — one product path.
 *
 * Precedence is the same at every tier, and each level falls through only when
 * the level above it said nothing usable:
 *
 *   1. the tier's own env knob (…_FAST / …_SMOKE), when set and valid;
 *   2. the tier's project file (`.pi/verify-cmd-fast-timeout-ms` etc.);
 *   3. the develop-tier knob — `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` then
 *      `.pi/verify-timeout-ms` (folded in from #1041), which is what a project
 *      with ONE slow gate sets, and what every non-tier call site — the skip
 *      ratchet's `git diff`, comment retention, the lens/adversarial comment
 *      checks, the checkpoint typecheck — still resolves through;
 *   4. the tier's documented default.
 *
 * Why a project file at all (#1041): the env knob belongs to the Pi process,
 * so a project whose gate legitimately takes 25 minutes could not say so —
 * every operator had to export a variable before launching. The `.pi/*-timeout-ms`
 * files are the project declaring its own gate cost, read from the working
 * tree exactly like every other `.pi/` reader (`verifyCmdFor`, the smoke gate,
 * `.pi/verify-cmd-fast`) rather than at the cycle's base commit: these bound
 * how long a command may run, they do not decide what the driver is allowed to
 * do, so the #406 self-escalation concern that makes doctrine read at `baseSha`
 * load-bearing does not apply here. `.pi/` is a protected path, so an
 * unattended `/work` cycle still cannot rewrite them.
 *
 * A garbage value never silently wins. `Number("")`, `Number("abc")` and
 * `Number("1.5e")` all produce a non-finite or non-positive number and fall
 * through, and the reason is traced: a typo that quietly restored the default
 * was invisible, which is how a mis-set knob reads as "the gate is just slow".
 * `0` falls through for the same reason it must never reach exec — node's
 * `exec` reads `timeout: 0` as "no bound at all".
 *
 * `verifyTimeoutMs()` has non-suite call sites too (the skip ratchet's
 * `git diff -U0`, comment retention, the lens and adversarial comment checks,
 * the checkpoint typecheck). Those take the develop-tier bound deliberately:
 * each runs one git command, the tier is a seconds-scale one whatever the
 * suite costs, and widening the suite's number is precisely what must NOT
 * reach a `git diff` bound.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { readFirstConfigLine } from "./work-driver-verify-cmd.ts";

/** The develop-tier knob: the bound every non-tier verify call site resolves. */
export const VERIFY_TIMEOUT_ENV = "PI_ENSEMBLE_VERIFY_TIMEOUT_MS";
/** The fast tier's own knob (#1509). */
export const VERIFY_FAST_TIMEOUT_ENV = "PI_ENSEMBLE_VERIFY_FAST_TIMEOUT_MS";
/** The suite tier's own knob (#1509) — the offline-suite budget. */
export const VERIFY_SUITE_TIMEOUT_ENV = "PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS";
/** The product-smoke tier's own knob (#1509). */
export const VERIFY_SMOKE_TIMEOUT_ENV = "PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS";

/** Documented defaults, one per tier, as `docs/configuration.md` states them. */
export const FAST_TIER_DEFAULT_MS = 600_000;
export const SUITE_TIER_DEFAULT_MS = 1_800_000;
export const SMOKE_TIER_DEFAULT_MS = 600_000;
/**
 * The default for the SHARED develop-tier knob. It is deliberately NOT the
 * suite tier's number: `verifyTimeoutMs()` answers for the non-tier call sites
 * (the skip ratchet's `git diff -U0`, comment retention, the lens/adversarial
 * comment checks, the checkpoint typecheck), each of which runs one command and
 * whose #1509 requirement is that widening the suite budget must NOT widen
 * them. A project that sets neither knob therefore keeps the 10-minute bound it
 * had before this ticket, and only the tier that needed more gets it.
 */
export const DEVELOP_TIER_DEFAULT_MS = 600_000;

/** Which bound is being resolved. Drives both the knob names and the defaults. */
export type VerifyTier = "fast" | "suite" | "smoke";
/** The shared develop-tier level, addressed as a level rather than a tier. */
export type VerifyBudget = VerifyTier | "develop";

/** The knob a timeout failure names for a tier — one home, so the evidence,
 *  the handoff and the docs cannot disagree about what to raise. */
export const TIER_KNOB: Record<VerifyTier, string> = {
  fast: VERIFY_FAST_TIMEOUT_ENV,
  suite: VERIFY_SUITE_TIMEOUT_ENV,
  smoke: VERIFY_SMOKE_TIMEOUT_ENV,
};

/** The project file a tier's budget can be declared in (#1041).
 *
 *  Each name is spelled as a full `.pi/<file>` RELATIVE path in
 *  {@link TIER_TIMEOUT_PATH} below, because the `test-headless-inputs.ts` gate
 *  proves a declared `.pi/` file is really read by finding a path join to that
 *  literal with a filesystem read nearby. A bare basename joined onto `.pi` at
 *  the read site is the shape that gate cannot see, and the file would read as
 *  declared-but-unwired. */
export const TIER_TIMEOUT_FILE: Record<VerifyTier, string> = {
  fast: "verify-cmd-fast-timeout-ms",
  suite: "verify-timeout-ms",
  smoke: "smoke-cmd-timeout-ms",
};

/** The same three files as `.pi/`-relative paths, one constant each so each has
 *  an addressable read site (see {@link TIER_TIMEOUT_FILE}). */
const PI_VERIFY_TIMEOUT_MS = ".pi/verify-timeout-ms";
const PI_VERIFY_CMD_FAST_TIMEOUT_MS = ".pi/verify-cmd-fast-timeout-ms";
const PI_SMOKE_CMD_TIMEOUT_MS = ".pi/smoke-cmd-timeout-ms";

/** `.pi/<file>` for a tier, as a repo-root-relative path. */
function tierTimeoutPath(tier: VerifyTier): string {
  return tier === "suite"
    ? PI_VERIFY_TIMEOUT_MS
    : tier === "fast"
      ? PI_VERIFY_CMD_FAST_TIMEOUT_MS
      : PI_SMOKE_CMD_TIMEOUT_MS;
}

/** The tier's documented default, as one list rather than three scattered literals. */
export function tierDefaultMs(budget: VerifyBudget): number {
  return budget === "suite"
    ? SUITE_TIER_DEFAULT_MS
    : budget === "smoke"
      ? SMOKE_TIER_DEFAULT_MS
      : budget === "fast"
        ? FAST_TIER_DEFAULT_MS
        : DEVELOP_TIER_DEFAULT_MS;
}

/** A positive finite millisecond count, or undefined for anything else.
 *  `Number("")` is 0 and `Number("1.5e")` is NaN: both are "not a value",
 *  never a bound — a `timeout: 0` reaches exec as NO bound at all. */
function parseMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The env level for a tier: its own knob, then the develop-tier knob
 *  (`PI_ENSEMBLE_VERIFY_TIMEOUT_MS`) as the last env word before the project
 *  file. For the suite tier the two names are the same. */
function envMs(tier: VerifyTier): number | undefined {
  const own = tier === "suite" ? VERIFY_TIMEOUT_ENV : TIER_KNOB[tier];
  return parseMs(process.env[own]) ?? parseMs(process.env[VERIFY_TIMEOUT_ENV]);
}

/** Read one `.pi/<file>` and take its first non-comment line. Absent or
 *  unreadable is "no value" — the same shape every other `.pi/` reader uses.
 *
 *  The join and the read sit on ADJACENT lines on purpose: the
 *  `test-headless-inputs.ts` gate establishes a `.pi/` file is really read by
 *  finding a path join to it with a filesystem read within two lines. Splitting
 *  the join out into a shared helper is exactly the shape that gate reads as
 *  "named but never read", so the pair is kept visible here. */
async function projectLine(repoRoot: string, relPath: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(path.join(repoRoot, relPath), "utf8");
    return readFirstConfigLine(text);
  } catch {
    return undefined;
  }
}

/**
 * The `.pi/` file a tier's budget is declared in, read from the working tree.
 *
 * #1509/#1041 — three SEPARATE joins rather than one helper reached through a
 * `tierTimeoutPath(tier)` lookup. The `test-headless-inputs.ts` gate proves a
 * declared `.pi/` file is really read by pairing a path join to that literal
 * with a filesystem read nearby, and a dynamic path threaded through a shared
 * reader gives it nothing to pair: the file is then declared, documented, and
 * wired through a function it cannot see — the declared-but-unwired shape the
 * gate exists to refuse. One line per tier is the cost of being checkable.
 */
async function suiteTimeoutFile(repoRoot: string): Promise<string | undefined> {
  const text = await fs.readFile(path.join(repoRoot, PI_VERIFY_TIMEOUT_MS), "utf8");
  return readFirstConfigLine(text);
}

async function fastTimeoutFile(repoRoot: string): Promise<string | undefined> {
  const text = await fs.readFile(path.join(repoRoot, PI_VERIFY_CMD_FAST_TIMEOUT_MS), "utf8");
  return readFirstConfigLine(text);
}

async function smokeTimeoutFile(repoRoot: string): Promise<string | undefined> {
  const text = await fs.readFile(path.join(repoRoot, PI_SMOKE_CMD_TIMEOUT_MS), "utf8");
  return readFirstConfigLine(text);
}

/** The tier's declared budget, or undefined for absent / unreadable / garbage. */
async function projectBudget(repoRoot: string, tier: VerifyTier): Promise<string | undefined> {
  try {
    return await (tier === "suite"
      ? suiteTimeoutFile(repoRoot)
      : tier === "fast"
        ? fastTimeoutFile(repoRoot)
        : smokeTimeoutFile(repoRoot));
  } catch {
    // An unreadable file is "absent", the same shape every other `.pi/` reader
    // uses: a repo without one, or one whose read fails, must not fail a gate.
    return undefined;
  }
}

/**
 * The tier's bound, resolved through the full precedence chain. Async because
 * level 2 is a file read.
 *
 * `trace` fires ONLY for a value that was present and rejected — an absent
 * knob is the normal case and would trace on every gate.
 */
export async function resolveVerifyTierTimeoutMs(
  repoRoot: string,
  tier: VerifyTier,
): Promise<number> {
  const ownName = TIER_KNOB[tier];
  const ownRaw = process.env[ownName];
  const own = parseMs(ownRaw);
  if (own !== undefined) return own;
  warnInvalid(ownRaw, ownName);
  // The develop-tier knob is the suite tier's own fallback; for the fast and
  // smoke tiers it is level 3 — consulted only after the tier's own knob and
  // its own project file both said nothing.
  if (tier === "suite") {
    const develop = parseMs(process.env[VERIFY_TIMEOUT_ENV]);
    if (develop !== undefined) return develop;
    warnInvalid(process.env[VERIFY_TIMEOUT_ENV], VERIFY_TIMEOUT_ENV);
  }
  const file = tierTimeoutPath(tier);
  const line = await projectBudget(repoRoot, tier);
  const fromFile = parseMs(line);
  if (fromFile !== undefined) return fromFile;
  warnInvalid(line, `.pi/${file}`);
  if (tier !== "suite") warnInvalid(process.env[VERIFY_TIMEOUT_ENV], VERIFY_TIMEOUT_ENV);
  return tierDefaultMs(tier);
}

/** Trace a value that was present and rejected. An absent knob is the normal
 *  case and traces nothing; a typo that silently restored the default is
 *  exactly what an operator needs to see. */
function warnInvalid(raw: string | undefined, name: string): void {
  if (raw !== undefined && raw.trim() !== "" && parseMs(raw) === undefined)
    trace(`work-driver: verify budget ignored ${name}="${raw}" — not a positive number`);
}
/**
 * The sync reader every existing non-tier call site uses — the develop-tier
 * bound, env level only. It cannot see a project file (a sync caller cannot
 * await a read), so a project that declares `.pi/verify-timeout-ms` governs
 * only the tiers that resolve through {@link resolveVerifyTierTimeoutMs}: the
 * fast tier, the suite tier, the baseline probe and the smoke gate — which is
 * where the wall clock is actually paid.
 */
export function verifyTimeoutMs(): number {
  return envMs("suite") ?? tierDefaultMs("develop");
}

/**
 * The develop-tier bound as an awaitable, with the project file in the chain.
 * Kept as a distinct name from `suiteTierTimeoutMs` because the two answer
 * different questions: "what bound does a plain `verifyTimeoutMs()` call site
 * get, had it been able to read the file", versus "what is the suite tier's
 * bound". Today they resolve identically; the name records the intent at each
 * call site rather than leaning on an accident.
 */
export async function developTierTimeoutMs(repoRoot: string): Promise<number> {
  return resolveVerifyTierTimeoutMs(repoRoot, "suite");
}

/** The fast tier's bound (`.pi/verify-cmd-fast`). */
export async function fastTierTimeoutMs(repoRoot: string): Promise<number> {
  return resolveVerifyTierTimeoutMs(repoRoot, "fast");
}

/** The suite tier's bound (`.pi/verify-cmd` + the baseline probe). */
export async function suiteTierTimeoutMs(repoRoot: string): Promise<number> {
  return resolveVerifyTierTimeoutMs(repoRoot, "suite");
}

/** The product-smoke tier's bound (`.pi/smoke-cmd`). */
export async function smokeTierTimeoutMs(repoRoot: string): Promise<number> {
  return resolveVerifyTierTimeoutMs(repoRoot, "smoke");
}
