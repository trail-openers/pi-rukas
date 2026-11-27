/**
 * lean/review-test-accept — a review's explicit acceptance of an edited pre-existing test whose BASE
 * version fails against the head code, and the land gate's reading of it.
 *
 * Such an edit changes behaviour the project's own tests assert, so no build round can make the old
 * expectation pass; only a reviewer can say the change is the one the issue asks for. The grant is a
 * structured record, never prose: the adversarial reviewer ends its reply with ONE fenced block whose
 * info string is exactly {@link TEST_ACCEPT_INFO}, holding a JSON array of `{path, reason}`. Only paths
 * the newest green verify lists in `baseVersionRed` are kept, and two blocks, invalid JSON or one
 * malformed entry grant nothing. Each kept entry is bound to the head the accepting pass read, and land
 * honours it only in the NEWEST decided review's record and only on the head the newest green verify
 * certified — so an earlier review's acceptance, or one about bytes a later push replaced, never carries.
 */
import { fencedBlocks } from "./spec.ts";
import {
  ACCEPT_REASON_MAX_CHARS,
  type TestEditAcceptance,
  acceptanceProblem,
} from "./state-outcome-gates.ts";
import { type Step, newestDecided } from "./state.ts";
import { promptText } from "./text-fence.ts";

/** The info string of the one fenced block that carries the grant. */
export const TEST_ACCEPT_INFO = "lean-test-accept v1";

/** The edited test files whose base version the newest green verify recorded as failing. */
export function pendingTestEdits(steps: Step[]): string[] {
  const verify = newestDecided(steps, "verify")?.outcome;
  return verify?.kind === "green" ? (verify.projectRoster?.baseVersionRed ?? []) : [];
}

/** What every review seat is told, or `""` when no edited test needs an acceptance. */
export function testEditSection(pending: readonly string[]): string {
  if (pending.length === 0) return "";
  return [
    "## Edited pre-existing tests that need an explicit acceptance",
    "",
    "The run edited these pre-existing test files, and their BASE version fails against the head code: the run changed behaviour they assert. The merge is refused unless the adversarial reviewer accepts each one. A reviewer who judges an edit illegitimate — it weakens a test instead of following a behaviour change the issue asks for — reports it as a finding.",
    "",
    ...pending.map((p) => `- \`${promptText(p, 300)}\``),
    "",
    `Adversarial reviewer: to accept, end your reply with one fenced code block whose info string is exactly \`${TEST_ACCEPT_INFO}\`, holding a JSON array of {"path": "<a path above>", "reason": "<one line: why the old expectation is wrong for this issue>"}. Leave a path out to withhold it; with no such block nothing is accepted.`,
  ].join("\n");
}

/** The acceptances a reviewer's reply grants for `pending`, each bound to `head`. */
export function readTestAcceptances(
  text: string,
  pending: readonly string[],
  head: string,
): TestEditAcceptance[] {
  if (pending.length === 0) return [];
  const blocks = fencedBlocks(text).filter((b) => b.info === TEST_ACCEPT_INFO);
  if (blocks.length !== 1) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0]?.content ?? "");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TestEditAcceptance[] = [];
  for (const raw of parsed as unknown[]) {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const reason =
      typeof r.reason === "string" ? promptText(r.reason, ACCEPT_REASON_MAX_CHARS - 1) : r.reason;
    const entry = { path: r.path, reason, head };
    if (acceptanceProblem(entry) !== undefined) return [];
    const path = entry.path as string;
    if (pending.includes(path) && !out.some((a) => a.path === path))
      out.push({ path, reason: reason as string, head });
  }
  return out;
}

/** The base-version-red files the newest review did not accept on the head verify certified. */
export function unacceptedTestEdits(steps: Step[]): string[] {
  const red = pendingTestEdits(steps);
  if (red.length === 0) return [];
  const head = newestDecided(steps, "verify")?.outcome?.verifiedHead;
  const review = newestDecided(steps, "review")?.outcome;
  const returned = review?.kind === "done" || review?.kind === "fixed";
  const accepted = new Set(
    (returned ? (review?.review?.accepted ?? []) : [])
      .filter((a) => typeof head === "string" && a.head === head)
      .map((a) => a.path),
  );
  return red.filter((p) => !accepted.has(p));
}

/** The land refusal for {@link unacceptedTestEdits}, naming each file. */
export function unacceptedTestEditsRefusal(files: readonly string[]): string {
  return `the base versions of these edited pre-existing test files fail against the head code and the newest review did not accept them on the verified head: ${files.join(", ")} — a reviewer grants that with a \`${TEST_ACCEPT_INFO}\` block`;
}
