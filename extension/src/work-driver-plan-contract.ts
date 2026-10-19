/**
 * work-driver-plan-contract — #1322: plan threaded changes as one workstream.
 *
 * The coupling merge (work-driver-plan-coupling.ts, #1005) only sees edges
 * that exist at the base commit: path overlap, a declared `depends-on`, and a
 * grep for file basenames. A change that threads a new value through a
 * pipeline creates its own edges: a field that is not on the type yet, an
 * export that is not written yet. No grep at base can see them, so the plan
 * for #1297 split one such change into four parallel workstreams, each of
 * which had to guess the others' symbols, and the cycle parked at
 * `verify-failed:develop`.
 *
 * Only the planner knows those edges, so the plan states them: each
 * workstream may declare `introduces:` (symbols it creates) and `consumes:`
 * (not-yet-existing symbols it uses). This module turns the contract into
 * what the driver already handles:
 *
 *   - `deriveContractEdges` — a workstream that consumes a symbol a sibling
 *     introduces gets a `dependsOn` edge to it. The coupling merge's rule 2
 *     then folds the pair; no new merge path.
 *   - `mergeWithContract` — runs the coupling merge, and when contract edges
 *     were derived, repeats it until nothing changes, so a chain of
 *     contract edges ends as one workstream rather than as a sibling left
 *     depending on a half that was folded elsewhere.
 *   - `detectPortReference` / `foldPortPlan` — an issue that names an
 *     existing commit or PR as the fix to port plans as ONE workstream
 *     whose scope is to apply that change and resolve the conflicts.
 *
 * A plan that declares no symbols, on an issue that names no port, takes the
 * pre-#1322 path unchanged. `PI_ENSEMBLE_PLAN_CONTRACT=0` turns all of this
 * off (the prompt doctrine stays).
 */

import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import type { CouplingResult } from "./work-driver-plan-coupling.ts";
import { execp } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";
import { foldTwo } from "./workstream-fold.ts";

/** #1322 — kill switch for the contract edges and the port fold. */
export function planContractEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_PLAN_CONTRACT;
  return v !== "0" && v !== "false";
}

/**
 * Normalise a declared symbol to the key two workstreams are matched on.
 * Planners write symbols the way they read in code, so the key tolerates
 * that: backticks are dropped, leading declaration keywords are skipped
 * (`export function foo` keys on `foo`), a type annotation and trailing
 * punctuation go (`providerRepeats?: number` → `providerRepeats`), as do a
 * call `()` and any trailing prose. A qualified name
 * (`errorStop.providerRepeats`, `Mod::name`, `Type#field`) is matched on its
 * last segment — one workstream says "adds `providerRepeats` to errorStop",
 * the other "reads errorStop.providerRepeats", and they mean the same
 * symbol. A false match only merges two workstreams, which is the safe
 * direction.
 */
const DECL_KEYWORDS = new Set([
  "export",
  "default",
  "new",
  "function",
  "type",
  "const",
  "let",
  "var",
  "interface",
  "field",
  "class",
  "enum",
  "async",
  "readonly",
  "static",
]);
export function symbolKey(raw: string): string | undefined {
  const tokens = raw
    .replace(/`/g, "")
    .trim()
    .split(/[\s(]+/)
    .filter(Boolean);
  const head = tokens.find((t) => !DECL_KEYWORDS.has(t.toLowerCase()));
  if (!head) return undefined;
  // A single `:` starts a type annotation; `::` is a path separator.
  const name = head.replace(/(?<!:):(?!:).*$/, "").replace(/[?!:,;]+$/, "");
  const last = name
    .split(/\.|::|#/)
    .filter(Boolean)
    .pop()
    ?.replace(/[?!]+$/, "");
  return last && /^[A-Za-z_$][\w$]*$/.test(last) ? last : undefined;
}

/** One derived edge: `from` consumes `symbol`, which `to` introduces. */
export interface ContractEdge {
  from: string;
  to: string;
  symbol: string;
}

/**
 * #1322 — derive `dependsOn` edges from the declared contract. Pure: returns
 * a new map; a workstream with no new edge keeps its own object. A symbol
 * the consumer also introduces itself is not an edge (it is its own), and a
 * consumed symbol no sibling introduces is assumed to exist at base.
 */
export function deriveContractEdges(workstreams: Record<string, Workstream>): {
  workstreams: Record<string, Workstream>;
  edges: ContractEdge[];
} {
  const introducers = new Map<string, string[]>();
  for (const ws of Object.values(workstreams)) {
    for (const s of ws.introduces ?? []) {
      const k = symbolKey(s);
      if (k) introducers.set(k, [...(introducers.get(k) ?? []), ws.id]);
    }
  }
  const edges: ContractEdge[] = [];
  const out: Record<string, Workstream> = { ...workstreams };
  if (introducers.size === 0) return { workstreams: out, edges };
  for (const [id, ws] of Object.entries(workstreams)) {
    const own = new Set((ws.introduces ?? []).map(symbolKey));
    const deps = new Set(ws.dependsOn ?? []);
    const before = deps.size;
    for (const s of ws.consumes ?? []) {
      const k = symbolKey(s);
      if (!k || own.has(k)) continue;
      for (const to of introducers.get(k) ?? []) {
        if (to === id) continue;
        if (!deps.has(to)) edges.push({ from: id, to, symbol: k });
        deps.add(to);
      }
    }
    if (deps.size > before) out[id] = { ...ws, dependsOn: [...deps] };
  }
  return { workstreams: out, edges };
}

/**
 * #1322 — the coupling merge, with the contract's edges added first. No
 * derived edge → exactly one merge pass, the pre-#1322 behaviour. Otherwise
 * the merge repeats until it changes nothing (bounded by the workstream
 * count), because the merge is one pass: with A → B and C → A, the pass that
 * folds B into A can leave C depending on the union rather than in it.
 */
export async function mergeWithContract(
  workstreams: Record<string, Workstream>,
  merge: (ws: Record<string, Workstream>) => Promise<CouplingResult>,
): Promise<CouplingResult> {
  const derived = planContractEnabled()
    ? deriveContractEdges(workstreams)
    : { workstreams, edges: [] };
  for (const e of derived.edges) {
    trace(`work-driver: plan contract — ${e.from} consumes '${e.symbol}' from ${e.to}: depends-on`);
  }
  let result = await merge(derived.workstreams);
  if (derived.edges.length === 0) return result;
  const merges = [...result.merges];
  const bound = Object.keys(workstreams).length;
  for (let pass = 1; result.changed && pass < bound; pass++) {
    const again = await merge(result.workstreams);
    if (!again.changed) break;
    merges.push(...again.merges);
    result = again;
  }
  return { workstreams: result.workstreams, merges, changed: merges.length > 0 };
}

// A commit SHA (7–40 hex, at least one digit and one letter), an
// `owner/repo#N` / `owner/repo!N` / `owner/repo@sha` reference, or a PR /
// MR / commit URL. These are the references precise enough to port.
const SHA = String.raw`\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b`;
const XREF = String.raw`[\w.-]+/[\w.-]+(?:[#!]\d+|@[0-9a-f]{7,40})\b`;
const URL = String.raw`https?://\S+?/(?:pull|merge_requests|commit|commits)/[0-9a-f]+\b`;
const STRONG = `(?:${URL}|${XREF}|(?:commit\\s+)?${SHA})`;
// Same-repo `PR #N` / `#N` are precise only after an explicit port verb.
const ANY = `(?:${STRONG}|(?:PR|MR|pull request|merge request)\\s*[#!]?\\d+|[#!]\\d+)`;
const PORT_RES = [
  // "port <ref>", "cherry-pick the commit <ref>", "backport the fix from <ref>"
  new RegExp(
    String.raw`\b(?:port|cherry[- ]?pick|backport)(?:s|ed|ing)?\s+(?:(?:the|this|that)\s+)?(?:(?:fix|change|commit|patch|pr|pull request|mr)s?\s+)?(?:(?:from|in|of|at)\s+)?(?:(?:the\s+)?(?:fork|upstream)\s+)?\(?(${ANY})`,
    "i",
  ),
  // "(already) fixed in <cross-repo ref>", "landed upstream as <URL>". A bare
  // SHA is context here, not a port: #1439 and #1557 quoted "fixed in <sha>"
  // in passing and were sent into cherry-picks the issue never asked for.
  new RegExp(
    String.raw`\b(?:fixed|implemented|landed|merged|solved|resolved)\s+(?:(?:already|upstream)\s+)?(?:in|by|as|at)\s+(?:(?:the\s+)?(?:fork|upstream)\s+(?:(?:as|in|at)\s+)?)?(?:(?:commit|PR|pull request|MR)\s+)?\(?(${URL}|${XREF})`,
    "i",
  ),
];
// A negation within the two words before the port verb.
const NEGATED = /(?:\b(?:not|never|without|avoid|no)|n't)\s+(?:[\w-]+\s+){0,2}$/i;

/**
 * #1322 — the commit or PR an issue body names as the fix to port, or
 * undefined. Deliberately narrow: a reference counts only next to a port
 * verb ("port", "cherry-pick", "backport") or a "fixed / landed in" phrase,
 * and a same-repo `#N` only after a port verb — a "Related: #1005" line is
 * context, not a port. A negated verb and a sentence about a regression are
 * never a port.
 *
 * A "fixed / landed in" phrase counts only with a cross-repo reference (a URL,
 * or `owner/repo#N` / `owner/repo@sha`). A bare SHA after "fixed in" is
 * context: issue bodies use the phrase in passing (a test fixture, a sibling
 * test's fix), and treating those as ports sent cycles into cherry-picks the
 * issue never asked for. The fork case (#1322) is a URL or xref, so it stays.
 * Explicit port verbs ("port", "cherry-pick", "backport") still take a bare SHA.
 */
export function detectPortReference(body: string): string | undefined {
  for (const sentence of body.split(/(?<=[.!?])\s+|\n+/)) {
    // A sentence about a regression names the commit that BROKE things, not
    // the one to port ("fixed in abc1234, regressed by def5678").
    if (/\bregress/i.test(sentence)) continue;
    for (const re of PORT_RES) {
      const m = re.exec(sentence);
      if (!m?.[1] || m.index === undefined) continue;
      // "do not cherry-pick #12", "don't port it", "never backported" — a
      // negated verb is the issue saying NOT to port.
      if (NEGATED.test(sentence.slice(0, m.index))) continue;
      return m[1].replace(/^commit\s+/i, "").trim();
    }
  }
  return undefined;
}

/** A bare commit SHA as written in prose (short or full, hex only). */
const BARE_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * #1439 — `git cat-file -e <sha>^{commit}` through the argv executor, so the
 * ref is data and never shell text. Any failure (no such object, not a
 * repo) reads as "not a commit here": the port cannot be cherry-picked either way.
 */
export async function isCommitInRepo(
  sha: string,
  repoRoot: string,
  exec: typeof execp = execp,
): Promise<boolean> {
  try {
    await exec("git", { argv: ["cat-file", "-e", `${sha}^{commit}`], cwd: repoRoot });
    return true;
  } catch (err) {
    // Only git's own exit status is an answer: 1 (object absent) or 128 (not a
    // valid object name / not a repo). A spawn failure (ENOENT, EAGAIN) or a
    // signal kill carries no numeric exit code. That is not evidence the commit
    // is absent, and reading it as absent would turn a real port into a fresh
    // implementation, so the port is kept and the check is traced as unknown.
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 1 || code === 128) return false;
    trace(
      `work-driver: plan contract \u2014 could not check whether ${sha} is a commit here (${String(code ?? "no exit code")}); keeping it as the port`,
    );
    return true;
  }
}

/**
 * The port reference for a single-issue cycle, read from the issue body the
 * explore step cached. A multi-issue cycle is never a port (one commit does
 * not fix several issues' worth of planned work), and an unreadable body is
 * no reference.
 */
export async function portReferenceForCycle(
  state: WorkState,
  issues: number[],
  repoRoot: string,
): Promise<string | undefined> {
  const artifact = state.pipelineState.issueBodyArtifact;
  if (!planContractEnabled() || issues.length !== 1 || !artifact) return undefined;
  let ref: string | undefined;
  try {
    ref = detectPortReference(await fs.readFile(artifact, "utf8"));
  } catch {
    return undefined;
  }
  // #1439 — an issue body quotes example SHAs (a test fixture, a placeholder).
  // A bare SHA that is not a commit in this repo cannot be cherry-picked, and
  // the developer finds no such object and stops. Only bare SHAs are checked;
  // URLs and PR/MR references are left as they are.
  if (ref && BARE_SHA.test(ref) && !(await isCommitInRepo(ref, repoRoot))) {
    trace(
      `work-driver: plan contract \u2014 issue names ${ref}, which is not a commit in this repo; not treating it as a port`,
    );
    return undefined;
  }
  if (ref) trace(`work-driver: plan contract \u2014 issue names ${ref} as the change to port`);
  return ref;
}

/** The plan-prompt section for a port issue; empty when there is none. */
export function portPlanSection(ref: string | undefined): string {
  if (!ref) return "";
  return [
    "",
    "",
    "## Port detected",
    "",
    `The issue names \`${ref}\` as an existing change that does this work. Plan ONE workstream (\`### default\`) whose scope is: apply ${ref} (cherry-pick it onto the cycle's base) and resolve the conflicts. List the files that change touches as its \`paths\`. The driver folds any multi-workstream plan for this issue into one.`,
  ].join("\n");
}

/**
 * #1322 — a port plan is ONE workstream. Folds every workstream into the
 * first (the shared fold: union of paths, fence minus the merged paths) and
 * sets the scope to applying the referenced change. No reference → the map
 * is returned as-is.
 */
export function foldPortPlan(
  workstreams: Record<string, Workstream>,
  ref: string | undefined,
): Record<string, Workstream> {
  const all = Object.values(workstreams);
  const first = all[0];
  if (!ref || !first) return workstreams;
  let merged = first;
  for (const ws of all.slice(1)) merged = foldTwo(merged, ws);
  const absorbed = all.slice(1).map((w) => w.id);
  if (absorbed.length > 0) {
    trace(
      `work-driver: plan contract — port ${ref}: folded ${absorbed.join(", ")} into ${first.id}`,
    );
  }
  const { dependsOn: _drop, ...rest } = merged;
  return {
    [first.id]: {
      ...rest,
      scope: `Port ${ref}: apply that change and resolve conflicts — ${first.scope}${absorbed.length > 0 ? ` (+merged: ${absorbed.join(", ")})` : ""}`,
    },
  };
}
