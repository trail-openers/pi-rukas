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
 * ## Wiring
 *
 * A small, dependency-free CLI (`bin/agents-md`-shaped `runAgentsMd`) plus the
 * exported functions. The `/agents-md` prompt body drives this CLI through
 * bash; the PM never edits the file by hand. The interactive "show the diff,
 * then ask" and the headless "show diff, write nothing" branches live in the
 * prompt layer, NOT here — this layer is deterministic and returns a
 * structured result so the prompt layer can render the diff and ask.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CheckResult, runChecks } from "./check.ts";
import { type DetectedFacts, detectFacts } from "./detect.ts";
import {
  type LedgerRow,
  driftWarnings,
  mergeAutoRows,
  parseLedger,
  renderLedger,
  upsertRow,
} from "./ledger.ts";
import { MARKER_VERSION, parseMarkers, presentIds, sectionContent } from "./markers.ts";
import { commandsBody, environmentBody, gatesBody, omissionFor, renderAgent } from "./renderer.ts";

export type Verb = "create" | "update" | "check";

/** Injectable I/O so tests can stub the write path and inject clock/file reads. */
export interface FsOps {
  readFile: (p: string) => string;
  writeFile: (p: string, bytes: string) => void;
  stat: (p: string) => boolean;
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
  /** True when newBytes !== oldBytes, i.e. the write codepath would be entered. */
  wouldWrite: boolean;
  /** Managed section ids present after the operation. */
  managedIds: string[];
  /** Omitted sections and why (for the operator to see). */
  omitted: { id: string; reason: string }[];
  /** A drift warning if an operator row no longer matches the derivation. */
  drift?: string;
}

export interface VerbResult {
  verb: Verb;
  plan?: Plan;
  check?: CheckResult;
  error?: string;
  exitCode: number;
}

function fileState(fs: AgentsMdFs, file: string): FileState {
  if (!fs.stat(file)) return "no-file";
  const content = fs.readFile(file);
  try {
    return presentIds(content).length > 0 ? "has-markers" : "no-markers";
  } catch {
    // Markers present but corrupt — treat as has-markers; the verb will refuse.
    return "has-markers";
  }
}

/**
 * The default preamble for a freshly-created file. Kept deliberately minimal:
 * it is the ONE byte of generated prose, and everything after it is managed.
 */
const DEFAULT_PREAMBLE =
  "# AGENTS.md\n\n<!-- pi-ensemble:agents-md:managed — the sections below are maintained by /agents-md; edits between the markers are preserved on update. -->\n";

export function createAgent(root: string, file: string, fs: AgentsMdFs = DEFAULT_FS): VerbResult {
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
  const ledger = initialLedger(facts, today);
  const bytes = renderAgent({ facts, ledger, preamble: DEFAULT_PREAMBLE, version: MARKER_VERSION });
  fs.writeFile(file, bytes);
  return {
    verb: "create",
    plan: {
      state: "no-file",
      newBytes: bytes,
      oldBytes: "",
      wouldWrite: true,
      managedIds: presentIds(bytes),
      omitted: omittedSections(facts),
    },
    exitCode: 0,
  };
}

export function updateAgent(root: string, file: string, fs: AgentsMdFs = DEFAULT_FS): VerbResult {
  const state = fileState(fs, file);
  if (state === "no-file") {
    return createAgent(root, file, fs);
  }
  const current = fs.readFile(file);
  let parsed: string[];
  try {
    parsed = presentIds(current);
  } catch (e) {
    return {
      verb: "update",
      error: `refusing to update corrupt markers: ${(e as Error).message}`,
      exitCode: 2,
    };
  }
  const facts = detectFacts(root);
  const today = fs.today?.() ?? new Date().toISOString().slice(0, 10);

  // The three fact-derived bodies — the same pure helpers the fresh-file
  // builder uses, so the two cannot drift apart.
  const updates = new Map<string, string>();
  const omitted: { id: string; reason: string }[] = [];
  for (const [id, body] of [
    ["quality-gates", gatesBody(facts)],
    ["commands", commandsBody(facts)],
    ["environment", environmentBody(facts)],
  ] as const) {
    if (typeof body === "string") updates.set(id, body);
    else omitted.push({ id, reason: body.omit });
  }

  // 2. Merge the ledger once on the CURRENT bytes: keep operator rows,
  //    supersede changed auto rows, and record any new omissions.
  const auto = currentAutoRows(facts, today);
  const existingLedger = parseExistingLedger(current);
  if (existingLedger === undefined) {
    return {
      verb: "update",
      error: "refusing to update corrupt markers: decision-ledger has a malformed row",
      exitCode: 2,
    };
  }
  const merged = mergeOmissionRows(mergeAutoRows(existingLedger, auto), omitted, today);
  const drift = driftWarnings(existingLedger, auto);

  // 3. Single-pass rebuild: the markers are parsed ONCE from the original
  //    bytes and every managed span is resolved up front, so there is no
  //    shifting-index problem — the output is built in document order, copying
  //    original bytes verbatim everywhere except the managed content of the
  //    sections being updated (the #253 invariant: bytes outside a managed
  //    span are never touched).
  const { spans } = parseMarkers(current);
  const spanById = new Map(spans.map((s) => [s.id, s]));
  const ledgerSpan = spanById.get("decision-ledger");
  const ledgerBody = renderLedger(merged);
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    let body: string | undefined;
    if (span.id === "decision-ledger" && ledgerSpan) body = ledgerBody;
    else if (span.id !== "decision-ledger") body = updates.get(span.id);
    if (body === undefined) continue; // content unchanged — copy verbatim
    parts.push(current.slice(cursor, span.contentStart));
    parts.push(body.endsWith("\n") ? body : `${body}\n`);
    cursor = span.contentEnd;
  }
  parts.push(current.slice(cursor));
  const bytes = parts.join("");

  const wouldWrite = bytes !== current;
  // The single write codepath. A no-op update (wouldWrite false) never enters
  // this — which is exactly what the idempotency test asserts by stubbing
  // writeFile to throw. createAgent writes unconditionally (file absent).
  if (wouldWrite) {
    fs.writeFile(file, bytes);
  }
  return {
    verb: "update",
    plan: {
      state,
      newBytes: bytes,
      oldBytes: current,
      wouldWrite,
      managedIds: parsed,
      omitted: omittedSections(facts),
      drift: drift.length
        ? drift.map((d) => `${d.key}: "${d.asked}" → derives "${d.derived}"`).join("; ")
        : undefined,
    },
    exitCode: 0,
  };
}

export function checkAgent(
  root: string,
  file: string,
  opts: { deep?: boolean } = {},
  fs: AgentsMdFs = DEFAULT_FS,
): VerbResult {
  if (!fs.stat(file)) {
    return { verb: "check", error: "AGENTS.md does not exist", exitCode: 2 };
  }
  const content = fs.readFile(file);
  // Gate commands can only be extracted from a file whose markers parse; a
  // corrupt file is caught by runChecks below and refused (exit 2).
  let gateCommands: string[] = [];
  try {
    gateCommands = gateCommandsFrom(content);
  } catch {
    // Corruption — runChecks will catch it and return exit 2. Pass empty.
    gateCommands = [];
  }
  const result = runChecks(root, content, { gateCommands, deep: opts.deep });
  return { verb: "check", check: result, exitCode: result.code };
}

// ---------------------------------------------------------------- helpers

function omissionRows(facts: DetectedFacts, today: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const id of ["quality-gates", "commands", "environment"] as const) {
    const reason = omissionFor(facts, id);
    if (reason) rows.push({ key: `omit:${id}`, value: reason, provenance: "auto", date: today });
  }
  return rows;
}

function initialLedger(facts: DetectedFacts, today: string): LedgerRow[] {
  return omissionRows(facts, today);
}

function currentAutoRows(facts: DetectedFacts, today: string): LedgerRow[] {
  return omissionRows(facts, today);
}

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
 * The current decision-ledger rows, or undefined when the section is malformed.
 * A corrupt ledger row MUST refuse the update (exit 2) — silently continuing
 * with an empty ledger would delete every `[asked:operator]` decision on the
 * next write.
 */
function parseExistingLedger(bytes: string): LedgerRow[] | undefined {
  const body = sectionContent(bytes, "decision-ledger");
  if (body === undefined) return [];
  try {
    return parseLedger(body);
  } catch {
    return undefined;
  }
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
    const body = sectionContent(content, id);
    if (!body) continue;
    for (const m of body.matchAll(/`([^`]+)`/g)) {
      const line = m[1];
      if (line && !out.includes(line)) out.push(line);
    }
  }
  return out;
}

export { fileState };

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
    const c = r.check;
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
