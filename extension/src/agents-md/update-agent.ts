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
  upsertRow,
} from "./ledger.ts";
import {
  MARKER_VERSION,
  insertSectionAfter,
  parseMarkers,
  presentIds,
  sectionContent,
} from "./markers.ts";
import { codeStyleBody, commandsBody, environmentBody, gatesBody } from "./renderer.ts";
import {
  type AgentOverride,
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

    const today = fs.today?.() ?? new Date().toISOString().slice(0, 10);
    const existingLedger = parseExistingLedger(current);
    if (existingLedger === undefined) {
      return {
        verb: "update",
        error: "refusing to update corrupt markers: decision-ledger has a malformed row",
        exitCode: 2,
      };
    }

    // The B1↔B2 seam: when `agentOverride.facts` is supplied, the three fact
    // sections are built from it via the EXISTING gatesBody/commandsBody/
    // environmentBody functions (the same functions a rich-manifest project
    // already uses) INSTEAD of a fresh detectFacts(). The resulting section
    // rows get [detected:agent,<today>] provenance. When absent, fall back to
    // detectFacts(root) exactly as before.
    const agentOverride: AgentOverride | undefined = effectiveOpts.agentOverride;
    const useOverride = agentOverride?.facts !== undefined;
    const facts = useOverride ? (agentOverride.facts as DetectedFacts) : detectFacts(root);

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

    // The code-style section (agent-derived, plain bullets — it has no
    // omission concept, so it is never added to `omitted`).
    const codeStyleOut = agentOverride?.codeStyleBullets
      ? codeStyleBody(agentOverride.codeStyleBullets)
      : undefined;
    if (codeStyleOut !== undefined) updates.set("code-style", codeStyleOut);

    // Build the body splices FIRST (no ledger yet). This gives us the
    // post-update file bytes that the omission re-derivation below uses.
    // The splice loop rewrites only spans present in the file; the code-style
    // pair is inserted explicitly after it (first-time insertion, Item 2).
    const { spans } = parseMarkers(current);
    const parts: string[] = [];
    let cursor = 0;
    for (const span of spans) {
      let body: string | undefined;
      if (span.id !== "decision-ledger") body = updates.get(span.id);
      if (body === undefined) continue;
      parts.push(current.slice(cursor, span.contentStart));
      parts.push(body.endsWith("\n") ? body : `${body}\n`);
      cursor = span.contentEnd;
    }
    parts.push(current.slice(cursor));
    let bytes = parts.join("");

    // First-time code-style insertion: the splice loop above only REWRITES
    // spans already present in the file. When code-style content is supplied
    // but the file has no existing code-style span, explicitly insert it after
    // the environment section (the same primitive the scaffold post-pass uses).
    // Absent bullets → no pair, no omission row (handled above).
    if (codeStyleOut !== undefined && !spans.some((s) => s.id === "code-style")) {
      bytes = insertSectionAfter(bytes, "code-style", codeStyleOut, "environment");
    }

    // --- Merge ledger. ---
    const FACT_IDS = ["quality-gates", "commands", "environment"] as const;
    // The `auto` parameter to mergeAutoRows is the omission rows for the
    // NON-detected ids. The filter is the Item-4 omission suppression (the
    // churn-loop fix): it keys off the EXISTING ledger's provenance for the
    // section id itself — an id that already carries a [detected:agent] row
    // has its omit:<id> row dropped so it is never re-stamped with today's
    // date. This is what makes a routine update on a no-manifest fixture
    // (whose ledger already carries [detected:agent] rows from a prior
    // agentOverride call) upsert ZERO omit:* rows, even across a date
    // rollover. The filter keys off the section id (quality-gates /
    // commands / environment), NEVER off the omit:<id> rows (auto-provenance
    // by construction — filtering those would be a no-op).
    const detectedAgentIds = new Set(
      existingLedger.filter((r) => r.provenance === "detected").map((r) => r.key),
    );
    const auto = omissionRowsFn(facts, today).filter(
      (r) => !detectedAgentIds.has(r.key.slice("omit:".length)),
    );
    let merged = mergeAutoRows(existingLedger, auto);

    // Item 5 (refresh) + Item 3 (first-time population). For each fact section
    // that agentOverride is writing (a body, not an omission): with
    // refresh:true the [detected:agent] row is DIRECTLY replaced (bypassing
    // mergeAutoRows' sticky rule, which would otherwise keep the old row when
    // the value is unchanged); without refresh the row is populated only for
    // ids that do NOT yet carry a [detected:agent,...] row. Sections that are
    // [auto,...] or [asked,...] are NEVER touched (provenance checked before
    // acting). A no-op — new body byte-identical (post trailing-newline
    // normalisation) to the existing section — keeps the existing row and its
    // date (no churn).
    if (useOverride) {
      for (const id of FACT_IDS) {
        const body = updates.get(id);
        if (body === undefined) continue; // omitted → no detected row
        const spliceForm = body.endsWith("\n") ? body : `${body}\n`;
        const existing = existingLedger.find((r) => r.key === id);
        const isDetected = existing?.provenance === "detected";
        if (effectiveOpts.refresh === true) {
          if (!isDetected) continue; // refresh only touches [detected:agent] rows
          const existingBody = sectionContent(current, id);
          const sameValue =
            existingBody !== undefined &&
            (existingBody.endsWith("\n") ? existingBody : `${existingBody}\n`) === spliceForm;
          if (sameValue) continue; // byte-identical → keep row + date, no churn
          merged = upsertRow(merged, {
            key: id,
            value: "agent",
            provenance: "detected",
            date: today,
          });
        } else if (!isDetected && existing?.provenance === undefined) {
          // First-time population: id has no existing ledger row at all.
          merged = upsertRow(merged, {
            key: id,
            value: "agent",
            provenance: "detected",
            date: today,
          });
        }
        // else: an existing [auto] row (rich manifest) or [detected] row
        // without refresh is left alone — first-time-only, never overwrite.
      }
    }

    // Add the omission rows for ids that are NOT agent-detected (Item 4
    // suppression). The `omitted` array (built from the agentOverride facts
    // when supplied) is filtered to exclude any id that has a [detected:agent]
    // row — the operator is not told a section is omitted when it is
    // agent-derived. The plan's `omitted` field reflects the same filter.
    const omittedForLedger = omitted.filter((o) => !detectedAgentIds.has(o.id));
    merged = mergeOmissionRows(merged, omittedForLedger, today);
    const drift = driftWarnings(existingLedger, auto);

    // Render the ledger back into the managed section of the spliced bytes.
    const { spans: spans2 } = parseMarkers(bytes);
    const ledgerSpan2 = spans2.find((s) => s.id === "decision-ledger");
    const ledgerBody = renderLedger(merged);
    const parts2: string[] = [];
    let cursor2 = 0;
    for (const span of spans2) {
      if (span.id === "decision-ledger" && ledgerSpan2) {
        parts2.push(bytes.slice(cursor2, span.contentStart));
        parts2.push(ledgerBody.endsWith("\n") ? ledgerBody : `${ledgerBody}\n`);
        cursor2 = span.contentEnd;
      }
    }
    parts2.push(bytes.slice(cursor2));
    bytes = parts2.join("");

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
        omitted: omittedForLedger.map((o) => ({ id: o.id, reason: o.reason })),
        drift: drift.length
          ? drift.map((d) => `${d.key}: "${d.asked}" → derives "${d.derived}"`).join("; ")
          : undefined,
        scaffoldedIds: scaffoldedIds.length ? scaffoldedIds : undefined,
      },
      exitCode: 0,
    };
  };
}
