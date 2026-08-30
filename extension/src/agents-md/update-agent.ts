/**
 * update-agent — the update verb for AGENTS.md.
 *
 * Reads the current file, parses markers, rebuilds managed sections from
 * project facts, runs the scaffold post-pass, and writes the new bytes back.
 *
 * Exported as a closure that receives external dependencies to avoid circular
 * imports with agents-md.ts.
 */

import type { AgentsMdFs } from "./agents-md.ts";
import { type DetectedFacts, detectFacts } from "./detect.ts";
import {
  type LedgerRow,
  driftWarnings,
  mergeAutoRows,
  mergeOmissionRows,
  parseLedger,
  renderLedger,
} from "./ledger.ts";
import { MARKER_VERSION, parseMarkers, presentIds } from "./markers.ts";
import { commandsBody, environmentBody, gatesBody } from "./renderer.ts";
import {
  SCAFFOLD_HEADING_MAP,
  type ScaffoldOpts,
  computeScaffold,
  runScaffoldPostPass,
} from "./scaffold.ts";
import type { OperatorAnswers } from "./scaffold.ts";

import { readFileSync, statSync, writeFileSync } from "node:fs";

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

// ------------------------------------------------------------------ types

/** Verb-result for update — no check payload. */
interface UpdateVerbResult {
  verb: "update";
  plan?: import("./agents-md.ts").Plan;
  error?: string;
  exitCode: number;
}

/** Type for the createAgent function passed as dependency. */
type CreateAgentFn = (
  root: string,
  file: string,
  fs: AgentsMdFs,
  opts: ScaffoldOpts | boolean,
  dryRunParam?: boolean,
) => import("./agents-md.ts").VerbResult;

/** Type for the runWrap function passed as dependency. */
type RunWrapFn = (
  root: string,
  file: string,
  fs: AgentsMdFs,
  dryRunParam: boolean,
  opts?: { scaffoldBodies?: { id: string; body: string }[]; answers?: OperatorAnswers },
) => import("./agents-md.ts").VerbResult;

/** Type for the omissionRows helper passed as dependency. */
type OmissionRowsFn = (facts: DetectedFacts, today: string) => LedgerRow[];

// ------------------------------------------------------------------ boilerplate detection

/**
 * Scan the current file for existing boilerplate section headings so the
 * scaffold post-pass can detect already-present sections (idempotency).
 *
 * Matches headings flexibly — tolerates different heading levels (# vs ##),
 * optional whitespace after the hash, bolded hashes (**# Heading**), and
 * trailing parentheticals or notes. This is important because brownfield
 * files rarely conform to the exact "# Heading" format the scaffold emits.
 *
 * Uses SCAFFOLD_HEADING_MAP from scaffold.ts so the name↔id mapping lives
 * in one place (#593 #1).
 */
function detectExistingBoilerplate(fileContent: string): Set<string> {
  const ids = new Set<string>();
  for (const line of fileContent.split("\n")) {
    const trimmed = line.trim();
    // Remove bold markers (**, __) and trailing whitespace/punctuation.
    const clean = trimmed.replace(/^\*+|_+/g, "").trim();
    for (const [name, id] of SCAFFOLD_HEADING_MAP) {
      // Match # or ## or ###... followed by optional space and the name.
      // The name is matched case-sensitively as a word boundary so "# Git
      // Workflow (notes)" matches but "# GitOps" does not.
      const re = new RegExp(
        `^(#{1,6})\\s+${name.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`,
        "i",
      );
      if (re.test(clean)) {
        ids.add(id);
        break; // this line matches a section — move to the next line
      }
    }
  }
  return ids;
}

// ------------------------------------------------------------------ parse ledger from current file

/**
 * Parse the decision-ledger from the current file content.
 * Returns `undefined` if the ledger has a malformed row (corrupt markers).
 */
function parseExistingLedger(content: string): LedgerRow[] | undefined {
  try {
    const { spans } = parseMarkers(content);
    const ledgerSpan = spans.find((s) => s.id === "decision-ledger");
    if (!ledgerSpan) return undefined;
    const ledgerBody = content.slice(ledgerSpan.contentStart, ledgerSpan.contentEnd);
    return parseLedger(ledgerBody);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ update verb

/**
 * The update verb: reads the current file, rebuilds managed sections, runs
 * scaffold, and writes back if changed.
 */
export function makeUpdateAgent(
  createAgentFn: CreateAgentFn,
  runWrapFn: RunWrapFn,
  omissionRowsFn: OmissionRowsFn,
): (
  root: string,
  file: string,
  fs?: AgentsMdFs,
  opts?: ScaffoldOpts | boolean,
  dryRunParam?: boolean,
) => UpdateVerbResult {
  return function updateAgent(
    root: string,
    file: string,
    fs: AgentsMdFs = DEFAULT_FS,
    opts: ScaffoldOpts | boolean = {},
    dryRunParam?: boolean,
  ): UpdateVerbResult {
    // Handle legacy 4-positional call: updateAgent(root, file, fs, true)
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

    // --- determine file state ---
    let state: "no-file" | "has-markers" | "no-markers";
    if (!fs.stat(file)) {
      state = "no-file";
    } else {
      try {
        state = presentIds(fs.readFile(file)).length > 0 ? "has-markers" : "no-markers";
      } catch {
        state = "has-markers"; // corrupt → treat as has-markers; verb will refuse
      }
    }

    if (state === "no-file") {
      return createAgentFn(root, file, fs, effectiveOpts, effectiveDryRun) as UpdateVerbResult;
    }

    if (state === "no-markers") {
      const scaffoldBodies: { id: string; body: string }[] = [];
      if (effectiveOpts.scaffold) {
        const scaffoldResult = computeScaffold(new Set(), {
          scaffold: true,
          answers: effectiveOpts.answers,
        });
        for (const s of scaffoldResult.sections) scaffoldBodies.push({ id: s.id, body: s.body });
      }
      return runWrapFn(root, file, fs, effectiveDryRun, {
        scaffoldBodies: scaffoldBodies.length ? scaffoldBodies : undefined,
        answers: effectiveOpts.answers,
      }) as UpdateVerbResult;
    }

    // --- has-markers path ---
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

    // Fact-derived bodies for managed sections.
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

    // Merge ledger.
    const auto = omissionRowsFn(facts, today);
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

    // Single-pass rebuild from markers.
    const { spans } = parseMarkers(current);
    const ledgerSpan = spans.find((s) => s.id === "decision-ledger");
    const ledgerBody = renderLedger(merged);
    const parts: string[] = [];
    let cursor = 0;
    for (const span of spans) {
      let body: string | undefined;
      if (span.id === "decision-ledger" && ledgerSpan) body = ledgerBody;
      else if (span.id !== "decision-ledger") body = updates.get(span.id);
      if (body === undefined) continue;
      parts.push(current.slice(cursor, span.contentStart));
      parts.push(body.endsWith("\n") ? body : `${body}\n`);
      cursor = span.contentEnd;
    }
    parts.push(current.slice(cursor));
    let bytes = parts.join("");

    // Scaffold post-pass: detect boilerplate headings for idempotency.
    const existingIds = new Set(parsed);
    for (const id of detectExistingBoilerplate(current)) existingIds.add(id);
    let scaffoldedIds: string[] = [];
    if (effectiveOpts.scaffold) {
      const scaffoldResult = computeScaffold(existingIds, {
        scaffold: true,
        answers: effectiveOpts.answers,
      });
      const post = runScaffoldPostPass(bytes, scaffoldResult, true);
      if (post.bytes !== bytes) {
        bytes = post.bytes;
        scaffoldedIds = post.scaffoldedIds;
        for (const id of post.scaffoldedIds) existingIds.add(id);
      }
    }

    // wouldWrite: when scaffold added nothing, file is already up-to-date.
    const scaffoldAdded = scaffoldedIds.length > 0;
    const wouldWrite = effectiveOpts.scaffold ? scaffoldAdded : bytes !== current;

    if (wouldWrite && !effectiveDryRun) {
      try {
        fs.writeFile(file, bytes);
      } catch (err) {
        return {
          verb: "update",
          error: `write FAILED: ${(err as Error).message}`,
          exitCode: 1,
        };
      }
    }

    return {
      verb: "update",
      plan: {
        state,
        newBytes: bytes,
        oldBytes: current,
        wouldWrite,
        managedIds: parsed,
        omitted: omitted.map((o) => ({ id: o.id, reason: o.reason })),
        drift: drift.length
          ? drift.map((d) => `${d.key}: "${d.asked}" → derives "${d.derived}"`).join("; ")
          : undefined,
        scaffoldedIds: scaffoldedIds.length ? scaffoldedIds : undefined,
      },
      exitCode: 0,
    };
  };
}
