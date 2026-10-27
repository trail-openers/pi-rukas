/**
 * The pre-#1856-round-2 duplicate disclosure renderer, extracted from git at
 * test time so a lens can watch the bound fail rather than take it on faith.
 *
 * `baseExcludeSection()` renders the same worst-case fixture
 * `test-plan-duplicate-exclusion-budget.ts` builds through the renderer as it
 * stood BEFORE the budget existed. The revision is pinned, not read from HEAD:
 * the base is a fact about the cycle (the commit this branch was cut from), and
 * a base-evidence helper that reads HEAD measures whatever is checked out now —
 * which, once the fix lands on main, is the fixed renderer itself, and the test
 * would keep asserting a regression that can no longer be reproduced. If that
 * pinned blob is ever missing, `baseExcludeSection` throws rather than passing.
 * The bytes are read with `git show`, the three imports it carried are inlined
 * from the SAME revision — the type-only ones erased, the one runtime helper
 * (`truncateForDisclosure`) copied through so what runs is that revision's code
 * and not this tree's — and the result is evaluated from a throwaway module
 * under the OS temp dir. Nothing under version control imports a stale copy, and
 * nothing depends on a scratch directory surviving between runs.
 *
 * If the extraction cannot be performed — no git, no HEAD, an unexpected file
 * shape — this throws. It never returns a number it did not actually measure: a
 * base-evidence helper that degrades to a plausible constant is the exact failure
 * mode #1856 exists to close.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The widest prior-art reason the producer composes: rule sentence + 400-char clause + tail. */
function worstReason(): string {
  const clause = "c".repeat(400);
  return `a CLOSED issue the risk check itself called prior art or a reversal target — "${clause}" (the risk check called it that in this clause)`;
}

/** 10 rows, every interpolable slot at its maximum. Shared with the test. */
export function worstRows(count = 10): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    number: 9007199254740000 + i,
    state: "CLOSED",
    title: "t".repeat(500),
    reason: worstReason(),
  }));
}

/** extension/ — this file lives in `extension/smoke-tests/lib/`. */
const EXT_DIR = path.resolve(import.meta.dirname, "..", "..");
/** The repository root, resolved from the checkout rather than assumed. */
const REPO = execFileSync("git", ["-C", EXT_DIR, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

/**
 * The commit whose `plan-duplicate-self.ts` renders the section with **no row
 * clips and no budget** — the state the bound replaced. This is #1856's own
 * round-1 commit, not the merge base: the file did not exist at `98f02444`, so
 * the merge base is not the code this bound displaced, and a probe that read
 * HEAD would eventually measure the fixed renderer and assert a regression that
 * can no longer be reproduced. A base is a pinned fact about the cycle.
 *
 * `baseExcludeSection` throws rather than passing if that blob cannot be read or
 * no longer carries the unbounded renderer, so a garbage base is a loud failure
 * instead of a test that quietly stops proving anything.
 */
const BASE_REV = "e66eb940";

/** The file at `rev`, read from git. Throws when it cannot be read. */
function show(rev: string, file: string): string {
  try {
    return execFileSync("git", ["-C", REPO, "show", `${rev}:${file}`], { encoding: "utf8" });
  } catch (err) {
    throw new Error(`base probe: git show ${rev}:${file} failed — ${(err as Error).message}`);
  }
}

/** The pre-fix module's own source, with its imports resolved from the same revision. */
function baseSource(): string {
  const imports = [
    [`import { truncateForDisclosure } from "./plan-gap-disclosure.ts";`, ""],
    [`import type { MechanicalInventory } from "./plan-inventory.ts";`, ""],
    [
      `import type { DuplicateRisk, ExcludedDuplicate } from "./plan-investigate.ts";`,
      `type DuplicateRisk = { level: string; rationale: string; downgradedFrom?: string; downgradeReason?: string; excludedIssues?: Array<{ number: number; state: string; title: string; reason: string }> };\ntype ExcludedDuplicate = { number: number; state: string; title: string; reason: string };`,
    ],
  ] as const;
  let src = show(BASE_REV, "extension/src/plan-duplicate-self.ts");
  for (const [from, to] of imports) {
    if (!src.includes(from)) throw new Error(`base probe: import line not found: ${from}`);
    src = src.replace(from, to);
  }
  const trunc = show(BASE_REV, "extension/src/plan-gap-disclosure.ts").match(
    /const RESIDUAL_DISPLAY_MAX = \d+;[\s\S]*?\n}\n/,
  );
  if (!trunc) throw new Error("base probe: could not locate truncateForDisclosure at the base");
  // The base is only a base if it is the UNBOUNDED renderer. If that commit ever
  // grew a budget module, this probe measures a bounded renderer and the test
  // that compares against it proves nothing — so it says so instead of passing.
  if (/plan-duplicate-disclosure|EXCLUSION_SECTION_MAX_CHARS/.test(src)) {
    throw new Error(
      `base probe: ${BASE_REV} already carries the exclusion budget — the base is no longer the unbounded renderer, so the comparison is void`,
    );
  }
  return `${src}\n${trunc[0]}\n`;
}

let cached: ((risk: never, sourceIssue: number) => string) | undefined;

/** The pre-fix `duplicateExclusionSection`, extracted and loaded once per process. */
async function baseRenderer(): Promise<(risk: never, sourceIssue: number) => string> {
  if (cached) return cached;
  const dir = mkdtempSync(path.join(tmpdir(), "pi-1856-base-"));
  const file = path.join(dir, "base-plan-duplicate-self.ts");
  writeFileSync(file, baseSource(), "utf8");
  const mod = (await import(file)) as { duplicateExclusionSection: unknown };
  if (typeof mod.duplicateExclusionSection !== "function") {
    throw new Error("base probe: extracted module exports no duplicateExclusionSection");
  }
  cached = mod.duplicateExclusionSection as (risk: never, sourceIssue: number) => string;
  return cached;
}

/**
 * The worst-case fixture rendered by the pre-fix renderer, in characters. A
 * measurement taken from the extracted module, never a recorded constant.
 */
export async function baseExcludeSection(): Promise<number> {
  const render = await baseRenderer();
  const risk = {
    level: "medium",
    rationale: "",
    downgradedFrom: "high",
    excludedIssues: worstRows(),
  };
  return render(risk as never, Number.MAX_SAFE_INTEGER).length;
}
