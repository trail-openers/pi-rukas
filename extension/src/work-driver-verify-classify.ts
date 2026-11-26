/**
 * work-driver-verify-classify — #2649: the CLOSED classification table for a
 * changed path that is not a graph node.
 *
 * Until now any such path answered `outside-graph:<path>` and the develop round
 * ran the whole offline suite — which is how a docs edit cost a factory cycle
 * 1,600 tests. The table below is the whole decision, in code, and
 * `test-verify-select-classify.ts` drives it row by row:
 *
 *   - `named`    — a repository text file that offline tests name by its EXACT
 *     repo-relative path (on the lexed code, under the always-run detector's own
 *     spelling rules). The selection is the always-run set plus those exact
 *     namers. The detector's DIRECTORY-level membership is deliberately not used
 *     to pull in every reader of `docs/`: a change to `docs/x.md` selects the
 *     tests that name `docs/x.md`.
 *   - `text`     — a repository text file no test names (a module, prompt, skill
 *     or manifest nothing quotes). The always-run set is the sound answer: any
 *     test that could read it reads repository text and already runs.
 *   - `non-code` — a file no test reads and that cannot change what a test runs
 *     (ignore files, editor and attribute files, a licence). Always-run only.
 *   - `helper`   — content under `smoke-tests/lib/` that no import edge can show
 *     (a shell or data helper). Its users are the tests that quote its exact path.
 *   - `config`   — configuration the develop command compiles or that tests read
 *     as configuration (the tsconfig files, the package manifest and lockfile,
 *     the bun config, `agents.json`, the timing allow list, anything under
 *     `.pi/`, `.github/` or `.devcontainer/`). Full suite: a selection built from
 *     imports cannot be trusted to cover what changes the compiler or the runner
 *     themselves.
 *   - `unknown`  — anything the rules above do not place. Keeps the existing
 *     `outside-graph:<path>` reason and the full suite, so a new kind of file can
 *     never be waved through by omission.
 *
 * A path the graph can walk returns `node` and is never classified here: `src/**`
 * modules, top-level `smoke-tests/*.ts`, and (since #2649) the TypeScript helpers
 * under `smoke-tests/lib/`.
 *
 * Paths are extension-relative, as everywhere in the selector (`src/x.ts`,
 * `smoke-tests/test-y.ts`); a caller holding repo-relative paths strips
 * `extension/` first.
 */

import type { OfflineTests } from "./work-driver-verify-offline-tests.ts";
import { isRepoPath, repoDirs, repoFiles } from "./work-driver-verify-repo-paths.ts";
import { type LiteralIndex, literalIndex, namersOf } from "./work-driver-verify-select-literals.ts";

/** What one changed path means for the selection. */
export type ChangedPathClass =
  | "node"
  | "named"
  | "text"
  | "non-code"
  | "helper"
  | "config"
  | "unknown"
  /** Internal to this module: a nameable repository file, which the caller's namers
   * answer decides between `named` and `text`. Never returned. */
  | "nameable";

/**
 * A path the graph walks: never classified, always resolved through imports.
 * `smoke-tests/lib/` TypeScript helpers join the graph with #2649; the switch that
 * governs it is read by the selector, which re-checks membership against the graph
 * it actually built.
 */
export const NODE_PATH_RE =
  /^(?:src\/(?:[^/]+\/)*[^/]+\.ts|smoke-tests\/[^/]+\.ts|smoke-tests\/lib\/(?:[^/]+\/)*[^/]+\.ts)$/;

/**
 * A non-code path: content no test reads and nothing the develop command compiles
 * or runs. Closed set, by basename — an ignore file, an editor or attribute file,
 * or a licence/notice. Anything else that is neither a node nor configuration is
 * `unknown` and falls back, so the safe direction cannot be reached by omission.
 */
const NON_CODE_BASENAMES = [
  ".gitignore",
  ".npmignore",
  ".dockerignore",
  ".editorconfig",
  ".gitattributes",
  ".prettierignore",
  ".nvmrc",
  "LICENSE",
  "NOTICE",
];

/** Configuration the develop command compiles, or that tests read as configuration. */
function isConfigPath(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  if (/^tsconfig[\w.-]*\.json$/.test(name)) return true;
  if (name === "package.json" || name === "package-lock.json" || name === "bun.lock") return true;
  if (name === "bunfig.toml" || name === ".npmrc" || name === "biome.json") return true;
  if (rel === "agents.json" || rel === "timing-allowlist.json") return true;
  if (rel.startsWith(".pi/") || rel.startsWith(".github/") || rel.startsWith(".devcontainer/")) {
    return true;
  }
  return false;
}

/** A leading interpolation or relative prefix that does not change which file a literal names. */
const LEADING_RE = /^(?:\$\{[^}]*\}\/|\.{1,2}\/|extension\/)*/;

/** Is this a repository path the always-run detector would accept from a reader? */
function isNameableRepoPath(rel: string): boolean {
  return repoFiles().includes(rel) || repoDirs().some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** The classification, plus the exact namers of a `named` path. */
export interface ClassifiedPath {
  kind: ChangedPathClass;
  /** Offline tests whose lexed code holds this path as an exact literal. */
  namers: string[];
}

/** The shared table: where a path sits, before anything asks who names it. */
function classifyTable(rel: string): ChangedPathClass {
  if (NODE_PATH_RE.test(rel)) return "node";
  if (isConfigPath(rel)) return "config";
  if (rel.startsWith("smoke-tests/lib/")) return "helper";
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  if (NON_CODE_BASENAMES.includes(name)) return "non-code";
  if (isNameableRepoPath(rel)) return "nameable";
  return "unknown";
}

/**
 * Classify one changed path, scanning the roster of offline tests the caller holds for
 * the exact namers of a nameable path. `classifyChangedPathIndexed` is the same table
 * answered from an index, and is what a selection uses; this form is the one the
 * classifier's own suite drives, so the rule stays assertable without the selector.
 */
export function classifyChangedPath(roster: OfflineTests, rel: string): ClassifiedPath {
  const kind = classifyTable(rel);
  if (kind !== "nameable") return { kind, namers: [] };
  const namers = exactNamers(roster, rel);
  return { kind: namers.length > 0 ? "named" : "text", namers };
}

/**
 * Classify one changed path from the caller's literal index (`literalIndex`, built once
 * per selection from the same roster): the classification is a table over the path, and
 * only a nameable path asks it a question — a Map lookup per spelling a test could have
 * written, where `classifyChangedPath` scans the roster. The answers are the same
 * because a literal that names a path must be spelled one of those ways.
 */
export function classifyChangedPathIndexed(index: LiteralIndex, rel: string): ClassifiedPath {
  const kind = classifyTable(rel);
  if (kind !== "nameable") return { kind, namers: [] };
  const namers = namersOf(index, rel, exactNamersSpelled);
  return { kind: namers.length > 0 ? "named" : "text", namers };
}

/**
 * The offline tests whose lexed code holds `rel` as an exact literal — the whole
 * inclusion test of the classifier's exact-namer rule, roster first, and the one place
 * that rule is spelled. A selection asks the index instead
 * (`classifyChangedPathIndexed`), which hands each candidate spelling to
 * `exactNamersSpelled` — the same comparison, so an index answer and a roster answer to
 * the same question cannot disagree. This is the line the mutation gate in
 * `test-verify-select-classify.ts` edits to prove the rule is what selects a named
 * file's tests.
 */
export function exactNamers(roster: OfflineTests, rel: string): string[] {
  const out: string[] = [];
  for (const name of roster.names) {
    const lexed = roster.lexed.get(name);
    if (lexed === undefined) continue;
    for (const s of [...lexed.strings, ...lexed.templates]) {
      if (isRepoPath(s) && s.replace(LEADING_RE, "") === rel) {
        out.push(name);
        break;
      }
    }
  }
  return out;
}

/**
 * The classifier's exact-namer rule on one literal: a repository path that spells `rel`
 * once its leading prefix is ignored. The second half of the test `exactNamers` asks of
 * the roster, and what a selection's index lookup asks of each candidate spelling.
 */
function exactNamersSpelled(s: string, rel: string): boolean {
  return isRepoPath(s) && s.replace(LEADING_RE, "") === rel;
}
