/**
 * agents-md — the verbs (create / update / check) over the pure core.
 *
 * The core modules (markers, renderer, detect, ledger) are pure and do no
 * filesystem writes. This module is the I/O shell: it reads the target file,
 * decides which verb applies, computes the new bytes with the pure renderer,
 * and — and only this layer — writes them back. The write path is the single
 * function the idempotency test stubs (`fsOps.writeFile`), so "the write
 * codepath was not entered" is a real, asserted property: a no-op update never
 * calls it.
 *
 * Wiring: a small CLI (`runAgentsMd`) plus the exported verb functions and
 * `runWrap` (the I/O shell of the brownfield `no-markers` wrap). The prompt
 * layer renders diffs and asks; this layer is deterministic.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CheckResult, runChecks } from "./check.ts";
import { type DetectedFacts, detectFacts } from "./detect.ts";
import { type LedgerRow, parseLedger, renderLedger, upsertRow } from "./ledger.ts";
import { omissionFor, renderAgent } from "./renderer.ts";
import {
  type ScaffoldOpts,
  computeScaffold,
  operatorChoicesLedgerRows,
  renderOperatorChoices,
  runScaffoldPostPass,
  runWrapScaffold,
} from "./scaffold.ts";
import {
  findManagedSections,
  managedSectionBody,
  presentManagedIds,
  stripLegacyMarkers,
} from "./section-detect.ts";
import { SIDECAR_RELATIVE_PATH, type SidecarPlan, sidecarDir, sidecarPath } from "./sidecar.ts";
import { makeUpdateAgent } from "./update-agent.ts";
import { runWrap } from "./wrap-io.ts";

export type Verb = "create" | "update" | "check";

/** Injectable I/O so tests can stub the write path and inject clock/file reads. */
export interface FsOps {
  readFile: (p: string) => string;
  writeFile: (p: string, bytes: string) => void;
  stat: (p: string) => boolean;
  /** Create a directory (no-op if it exists). Used for the sidecar's parent dir. */
  mkdir?: (p: string) => void;
}

export interface AgentsMdFs extends FsOps {
  /** Day-stamp for ledger provenance. Fixed in tests. */
  today?: () => string;
}

const DEFAULT_FS: AgentsMdFs = {
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, b) => writeFileSync(p, b),
  stat: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  today: () => new Date().toISOString().slice(0, 10),
};

/** The three states a target file can be in before a verb runs. */
export type FileState = "no-file" | "no-markers" | "has-markers";

export interface Plan {
  state: FileState;
  /** The exact bytes that WOULD be written (== current bytes for a no-op). */
  newBytes: string;
  /** The current bytes ("" when no file). */
  oldBytes: string;
  /** True when either file's bytes would change (AGENTS.md or the sidecar). */
  wouldWrite: boolean;
  /** Managed section ids present after the operation (the rendered file's markers). */
  managedIds: string[];
  /** Omitted sections and why (for the operator to see). */
  omitted: { id: string; reason: string }[];
  /** A drift warning if an operator row no longer matches the derivation. */
  drift?: string;
  /** Scaffolded boilerplate section ids (scaffolded:<id> ledger rows). */
  scaffoldedIds?: string[];
  /**
   * The sidecar (`.pi/agents-md-state.json`) write plan: its old/new bytes
   * and whether it would change. Post-#680 M1: the decision-ledger rows
   * live here, not in the rendered AGENTS.md.
   */
  sidecar: SidecarPlan;
}

export { SIDECAR_RELATIVE_PATH, sidecarPath };

export interface VerbResult {
  verb: Verb;
  plan?: Plan;
  check?: CheckResult;
  error?: string;
  exitCode: number;
}

function fileState(fs: AgentsMdFs, file: string): FileState {
  if (!fs.stat(file)) return "no-file";
  const raw = fs.readFile(file);
  // Post-#681 M2: managed sections are identified by heading text (not
  // HTML-comment markers), so the state discrimination is "has-managed-
  // headings" — a file with ≥1 managed heading takes the heading-splice
  // path, a file with none takes the brownfield wrap path. A file whose
  // legacy marker lines survive the strip (i.e. a marker-era file with no
  // heading yet) is has-markers: the update path strips them and re-anchors
  // the now-markerless spans, rather than the wrap appending duplicates.
  try {
    const stripped = stripLegacyMarkers(raw);
    // A true legacy (pre-migration) file is one whose managed marker lines
    // survive the strip: the strip removed pi-rukas / pi-ensemble managed
    // marker lines from it. A file with neither managed headings (after the
    // strip) nor surviving managed marker lines is a true brownfield file
    // → no-markers/wrap. A marker-era file that already has headings is
    // has-markers by heading presence alone.
    const ids = presentManagedIds(stripped);
    const hasManagedHeadings = ids.length > 0;
    const hadManagedMarkerLines =
      stripped !== raw && /<!--\s*(?:pi-rukas|pi-ensemble):agents-md:/.test(raw);
    if (hasManagedHeadings || hadManagedMarkerLines) return "has-markers";
    return "no-markers";
  } catch {
    // Corrupt structure — treat as has-markers; the verb will refuse.
    return "has-markers";
  }
}

/**
 * The default preamble for a freshly-created file. Kept deliberately minimal:
 * it is the ONE byte of generated prose, and everything after it is managed.
 * Post-#681 M2: the `:managed` HTML-comment preamble is gone — the file is
 * pure prose (headings + body only), so the preamble is just the title line.
 */
const DEFAULT_PREAMBLE = "# AGENTS.md\n";

function omissionRows(facts: DetectedFacts, today: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const id of ["quality-gates", "commands", "environment"] as const) {
    const reason = omissionFor(facts, id);
    if (reason) rows.push({ key: `omit:${id}`, value: reason, provenance: "auto", date: today });
  }
  return rows;
}

/**
 * Verb signatures carry `dryRun` as the LAST param (after `fs`) on purpose:
 * the idempotency test passes its `FsOps` stub positionally as the third
 * argument, so a param inserted before `fs` would break it. `dryRun: true`
 * computes the full plan (including `newBytes`) but never calls `fs.writeFile`.
 * For `check` the param is a no-op (it never writes) — it exists for
 * signature uniformity.
 *
 * `opts` sits between `fs` and `dryRun` (positional 4). When `opts` is a
 * boolean, it is treated as `dryRun` to preserve existing callers.
 */
export function createAgent(
  root: string,
  file: string,
  fs: AgentsMdFs = DEFAULT_FS,
  opts: ScaffoldOpts | boolean = {},
  dryRunParam?: boolean,
): VerbResult {
  // Handle legacy 4-positional call: createAgent(root, file, fs, true)
  // where `true` was dryRun.
  let effectiveOpts: ScaffoldOpts;
  let effectiveDryRun: boolean;
  if (typeof opts === "boolean") {
    effectiveOpts = {};
    effectiveDryRun = opts;
  } else {
    effectiveOpts = opts;
    effectiveDryRun = dryRunParam ?? false;
  }
  // The create/no-file path scaffolds BY DEFAULT: a fresh AGENTS.md carries
  // the universal doctrine sections. `scaffold: false` opts out; the
  // has-markers update path (update-agent.ts) stays opt-in on its own.
  const scaffold = effectiveOpts.scaffold ?? true;
  const answers = effectiveOpts.answers;
  if (fs.stat(file)) {
    // create refuses to touch an existing file — the operator must use update
    // or a brownfield wrap, which is an explicit decision, not a side effect.
    return {
      verb: "create",
      error: "AGENTS.md already exists; use update (or brownfield wrap) instead",
      exitCode: 2,
    };
  }
  const facts = detectFacts(root);
  const today = fs.today?.() ?? new Date().toISOString().slice(0, 10);
  let ledger = omissionRows(facts, today);

  // Scaffold post-pass: compute boilerplate sections and optional operator-choices.
  let factIds = new Set<string>(["quality-gates", "commands", "environment"]);
  let scaffoldedIds: string[] = [];
  // Post-#681 M2: renderAgent no longer takes a marker version — sections are
  // heading-delimited, and the renderer's `version` param is a vestigial
  // placeholder that is ignored.
  let bytes = renderAgent({ facts, preamble: DEFAULT_PREAMBLE, version: 1 });

  if (scaffold) {
    // Thread the pre-pass agentOverride (incl. the testingNotes supplement —
    // first-time population rides inside computeScaffold's skip-if-present
    // idempotency) through to the scaffold post-pass on the create path.
    const scaffoldResult = computeScaffold(factIds, {
      scaffold: true,
      answers,
      agentOverride: effectiveOpts.agentOverride,
    });
    // Add operator-choices ledger rows.
    if (answers) {
      ledger = [...ledger, ...operatorChoicesLedgerRows(answers, today)];
    }
    // Run post-pass: append boilerplate after the managed sections.
    const post = runScaffoldPostPass(bytes, scaffoldResult, false);
    if (post.bytes !== bytes) {
      bytes = post.bytes;
      scaffoldedIds = post.scaffoldedIds;
      factIds = new Set([...factIds, ...post.scaffoldedIds]);
    }
  }

  const sPath = sidecarPath(root);
  const sOld = fs.stat(sPath) ? fs.readFile(sPath) : "";
  const sNew = renderLedger(ledger);
  const sPlan: SidecarPlan = {
    path: sPath,
    oldBytes: sOld,
    newBytes: sNew,
    wouldWrite: sNew !== sOld,
  };

  if (!effectiveDryRun) {
    try {
      if (sPlan.wouldWrite) {
        fs.mkdir?.(sidecarDir(root));
        fs.writeFile(sPath, sNew);
      }
      fs.writeFile(file, bytes);
    } catch (err) {
      return {
        verb: "create",
        error: `write FAILED: ${(err as Error).message}`,
        exitCode: 1,
      };
    }
  }
  return {
    verb: "create",
    plan: {
      state: "no-file",
      newBytes: bytes,
      oldBytes: "",
      wouldWrite: true,
      // Post-#681 M2: the managed ids are detected from the FINAL bytes (after
      // the scaffold post-pass), so the plan reflects every managed heading in
      // the rendered file (fact sections + scaffold sections), not just the
      // fact sections renderAgent emitted on its own.
      managedIds: presentManagedIds(bytes),
      omitted: omittedSections(facts),
      scaffoldedIds: scaffoldedIds.length ? scaffoldedIds : undefined,
      sidecar: sPlan,
    },
    exitCode: 0,
  };
}

export const updateAgent = makeUpdateAgent(createAgent, runWrap, omissionRows);

export function checkAgent(
  root: string,
  file: string,
  opts: { deep?: boolean } = {},
  fs: AgentsMdFs = DEFAULT_FS,
  dryRun = false,
): VerbResult {
  void dryRun; // check never writes; the param exists for signature uniformity.
  if (!fs.stat(file)) {
    return { verb: "check", error: "AGENTS.md does not exist", exitCode: 2 };
  }
  const content = fs.readFile(file);
  // Gate commands can only be extracted from a file whose managed headings
  // resolve; a corrupt file (duplicate managed heading) is caught by runChecks
  // below and refused (exit 2).
  let gateCommands: string[] = [];
  let hasManagedSections = false;
  try {
    gateCommands = gateCommandsFrom(content);
    hasManagedSections = findManagedSections(content).length > 0;
  } catch {
    // Corruption — runChecks will catch it and return exit 2. Pass empty.
    gateCommands = [];
  }
  // Post-#680 M1: the ledger rows live in the sidecar, not the in-file span.
  // A missing sidecar while AGENTS.md has managed sections is a defined
  // refusal state (exit 2) — never re-derive, never lose an asked row.
  // A corrupt sidecar is the same. `hasManagedSections === false` (a file
  // with no pi-rukas markers at all) means the sidecar is not required.
  const sPath = sidecarPath(root);
  const sState = fs.stat(sPath);
  let ledgerRows: LedgerRow[] | null;
  if (!hasManagedSections) {
    ledgerRows = [] as LedgerRow[]; // no managed sections → no sidecar requirement
  } else if (!sState) {
    ledgerRows = null; // missing sidecar → refuse (exit 2), via runChecks
  } else {
    try {
      ledgerRows = parseLedger(fs.readFile(sPath));
    } catch {
      ledgerRows = null; // corrupt sidecar → refuse (exit 2)
    }
  }
  const result = runChecks(root, content, { gateCommands, deep: opts.deep, ledgerRows });
  return { verb: "check", check: result, exitCode: result.code };
}

// ---------------------------------------------------------------- helpers

function mergeOmissionRows(
  merged: LedgerRow[],
  omitted: { id: string; reason: string }[],
  today: string,
): LedgerRow[] {
  // o.reason comes from the same omissionFor source currentAutoRows uses,
  // so it is already the current derivation — upsert it by key (an existing
  // row with the same value is left untouched, a changed value is superseded
  // in place, a missing key is appended).
  return omitted.reduce(
    (out, o) =>
      upsertRow(out, { key: `omit:${o.id}`, value: o.reason, provenance: "auto", date: today }),
    merged,
  );
}

function omittedSections(facts: DetectedFacts): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = [];
  for (const id of ["quality-gates", "commands", "environment"] as const) {
    const reason = omissionFor(facts, id);
    if (reason) out.push({ id, reason });
  }
  return out;
}

/**
 * The exact gate-command shell lines currently in the quality-gates AND
 * commands sections. Both are managed and both are operator-editable, so a
 * hand-added command in either section must be visible to the deep check —
 * a commands-section-only gate must not be silently skipped. Lines containing
 * shell metacharacters ARE extracted here and reported as `invalid-shell`
 * downstream by `runChecks` (isSafeGateCommand) — they are never parsed or
 * executed.
 */
function gateCommandsFrom(content: string): string[] {
  const out: string[] = [];
  for (const id of ["quality-gates", "commands"] as const) {
    const body = managedSectionBody(content, id);
    if (!body) continue;
    for (const m of body.matchAll(/`([^`]+)`/g)) {
      const line = m[1];
      if (line && !out.includes(line)) out.push(line);
    }
  }
  return out;
}

export { fileState };

export { runWrap } from "./wrap-io.ts";

/**
 * CLI entry for the `/agents-md` prompt body.
 *
 *   bun runAgentsMd.ts create [root] [file]
 *   bun runAgentsMd.ts update [root] [file]
 *   bun runAgentsMd.ts check  [root] [file] [--deep]
 *
 * `root` defaults to the current directory; `file` defaults to `<root>/AGENTS.md`.
 * The exit code is the process exit code, so the prompt layer can branch on it:
 * 0 clean, 1 findings/drift, 2 refuse/corrupt, 3 gated-on-human. The output is
 * a short human-readable line plus, on update, a machine-readable plan marker
 * the prompt layer renders as a diff before asking.
 */
export function runAgentsMd(argv: string[]): number {
  const args = argv.filter((a) => a !== "");
  const verb = args[0] as Verb | undefined;
  const rest = args.slice(1).filter((a) => !a.startsWith("--"));
  const deep = args.includes("--deep");

  if (!verb || !["create", "update", "check"].includes(verb)) {
    console.error("usage: agents-md <create|update|check> [root] [file] [--deep]");
    return 2;
  }
  // Args: verb [root] [file] [--deep]. `file` defaults to <root>/AGENTS.md.
  const root = rest[0] ?? process.cwd();
  const file = rest[1] ?? path.join(root, "AGENTS.md");
  const rootDir = root;

  const r =
    verb === "create"
      ? createAgent(rootDir, file)
      : verb === "update"
        ? updateAgent(rootDir, file)
        : checkAgent(rootDir, file, { deep });

  if (r.error) {
    console.error(`error: ${r.error}`);
    return r.exitCode;
  }
  if (verb === "check") {
    const c = (r as VerbResult).check;
    if (!c) {
      console.error("error: no check result");
      return 2;
    }
    if (c.findings.length === 0) console.log("clean");
    else for (const f of c.findings) console.log(`${f.kind}: ${f.message}`);
    return c.code;
  }
  const plan = r.plan;
  if (!plan) {
    console.error("error: no plan result");
    return 2;
  }
  console.log(plan.wouldWrite ? "would write" : "no-op (already current)");
  console.log(`managed: ${plan.managedIds.join(", ")}`);
  if (plan.omitted.length)
    console.log(`omitted: ${plan.omitted.map((o) => `${o.id} (${o.reason})`).join(", ")}`);
  if (plan.drift) console.log(`drift: ${plan.drift}`);
  return 0;
}

// Allow `bun src/agents-md/agents-md.ts ...` invocation when this file is the entrypoint.
// Guarded on the BASENAME so a test file named test-agents-md-*.ts that imports
// this module does not accidentally trigger the CLI (process.argv[1] is the test).
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.basename(process.argv[1]) === "agents-md.ts"
) {
  process.exit(runAgentsMd(process.argv.slice(2)));
}
