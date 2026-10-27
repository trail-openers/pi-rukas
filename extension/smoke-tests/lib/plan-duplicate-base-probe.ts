/**
 * The pre-#1856-round-2 duplicate disclosure renderer, extracted from git at
 * test time so a lens can watch the bound fail rather than take it on faith.
 *
 * `baseExcludeSection()` renders the same worst-case fixture
 * `test-plan-duplicate-exclusion-budget.ts` builds through the renderer as it
 * stood at HEAD before the budget existed (`plan-duplicate-self.ts`, which has
 * no row clips and no section cap). The bytes are read with `git show`, the
 * three imports it carried are inlined from the SAME revision — the type-only
 * ones erased, the one runtime helper (`truncateForDisclosure`) copied through
 * so what runs is that revision's code and not this tree's — and the result is
 * evaluated from a throwaway module under the OS temp dir. Nothing under version
 * control imports a stale copy, and nothing depends on a scratch directory
 * surviving between runs.
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

const REPO = path.resolve(import.meta.dirname, "..", "..");

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
  let src = show("HEAD", "extension/src/plan-duplicate-self.ts");
  for (const [from, to] of imports) {
    if (!src.includes(from)) throw new Error(`base probe: import line not found: ${from}`);
    src = src.replace(from, to);
  }
  const trunc = show("HEAD", "extension/src/plan-gap-disclosure.ts").match(
    /const RESIDUAL_DISPLAY_MAX = \d+;[\s\S]*?\n}\n/,
  );
  if (!trunc) throw new Error("base probe: could not locate truncateForDisclosure at HEAD");
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
