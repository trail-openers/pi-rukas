/**
 * renderer — the PURE FUNCTION at the heart of the /agents-md feature.
 *
 *     renderAgent({ facts, ledger, preamble, version }) -> bytes
 *
 * ## Why pure is the whole design
 *
 * Idempotency — the property that makes a regenerator safe to run on a live
 * repo — is a theorem about the renderer, and it is only provable when the
 * renderer is a function of its inputs alone. No `Date.now()`, no
 * `Math.random()`, no map-iteration-order dependence, no LLM call, no file
 * reads. Feed the same `(facts, ledger, preamble, version)` twice and you get
 * the same bytes, and the idempotency test asserts exactly that with
 * `Buffer.equals`.
 *
 * The timestamp problem is the one that would otherwise make this impure: the
 * decision ledger needs a date stamp. The resolution is that the date is a
 * *caller-supplied* part of the ledger (each `LedgerRow.date`), not a value the
 * renderer computes. So the pure core stays pure, and the idempotency test
 * renders with a fixed ledger and gets byte-identical output. (The ledger is
 * the one section whose bytes legitimately change between runs; everything the
 * renderer derives from `facts` is stable.)
 *
 * ## Omit-and-ledger, never invent
 *
 * A section is emitted only when detection can derive it. A section whose
 * facts are absent is **omitted**, and a `[auto]` ledger row records
 * `section omitted: <reason>`. The renderer never writes a gate command it was
 * not given — "never write a command you cannot prove runs" is enforced here
 * by only emitting `facts.commands`, and validated at write time by check.ts.
 */

import type { DetectedFacts } from "./detect.ts";
import { type LedgerRow, renderLedger } from "./ledger.ts";
import { renderSection } from "./markers.ts";

/** The fixed section order. Omitted sections leave a gap, not a reflow. */
const SECTION_ORDER = ["quality-gates", "commands", "environment", "decision-ledger"] as const;

/**
 * The single source of truth for omission reasons, keyed by managed section
 * id. Both the section bodies below and the decision-ledger omission rows
 * (recorded by agents-md.ts and re-derived by check.ts) call this, so the
 * "why was this section skipped" text cannot drift between the file on disk
 * and what the drift check compares it against.
 */
export function omissionFor(facts: DetectedFacts, id: string): string | undefined {
  if ((id === "quality-gates" || id === "commands") && facts.commands.length === 0) {
    return id === "quality-gates"
      ? "no gate commands could be derived from the project manifest"
      : "no commands could be derived from the project manifest";
  }
  if (id === "environment" && !facts.manifest) return "no recognised manifest was detected";
  return undefined;
}

/**
 * Pure section bodies. These are the single source of truth for what each
 * managed section contains — both the fresh-file builder and the brownfield
 * updater call these, so the two cannot drift apart. A section whose facts are
 * absent returns the `omissionFor` reason instead of a body.
 */
export function gatesBody(facts: DetectedFacts): string | { omit: string } {
  const omit = omissionFor(facts, "quality-gates");
  if (omit) return { omit };
  const lines = facts.commands.map((c) => `- **${c.name}** — \`${c.command}\``);
  return `Run these before pushing. All must pass locally:\n\n${lines.join("\n")}`;
}
export function commandsBody(facts: DetectedFacts): string | { omit: string } {
  const omit = omissionFor(facts, "commands");
  if (omit) return { omit };
  const rows = facts.commands.map((c) => `| ${c.kind} | \`${c.command}\` |`).join("\n");
  return `| kind | command |\n| --- | --- |\n${rows}`;
}
export function environmentBody(facts: DetectedFacts): string | { omit: string } {
  const omit = omissionFor(facts, "environment");
  if (omit) return { omit };
  const lines = [
    `- Manifest: \`${facts.manifest}\``,
    facts.packageManager ? `- Package manager: \`${facts.packageManager}\`` : "",
    facts.language ? `- Language: \`${facts.language}\`` : "",
    facts.ciWorkflows.length
      ? `- CI workflows: ${facts.ciWorkflows.map((w) => `\`.github/workflows/${w}\``).join(", ")}`
      : "- CI: no `.github/workflows/` detected",
  ].filter((l) => l !== "");
  return lines.join("\n");
}

/** The three fact-derived sections, in fixed order. */
export const FACT_SECTIONS: {
  id: string;
  body: (f: DetectedFacts) => string | { omit: string };
}[] = [
  { id: "quality-gates", body: gatesBody },
  { id: "commands", body: commandsBody },
  { id: "environment", body: environmentBody },
];

export interface RenderInput {
  facts: DetectedFacts;
  ledger: LedgerRow[];
  /**
   * The operator/human-authored preamble that precedes all managed sections.
   * For a fresh file this is the file's title/intro; for a brownfield wrap it
   * is the original file's leading prose. It is copied verbatim.
   */
  preamble: string;
  version: number;
}

/**
 * The pure render: fixed section order, managed bodies, verbatim preamble.
 *
 * The decision-ledger body is rendered from the caller-supplied `ledger` (which
 * may already contain omission rows plus any operator rows). The ledger is
 * always emitted (even when empty) because its absence would itself be a
 * signal the file was never managed.
 */
export function renderAgent(input: RenderInput): string {
  const { facts, ledger, preamble, version } = input;
  void version;

  const parts: string[] = [];
  if (preamble.trim().length > 0) {
    parts.push(`${preamble.replace(/\n$/, "")}\n`);
  }

  for (const { id, body } of FACT_SECTIONS) {
    const b = body(facts);
    if (typeof b === "string") parts.push(renderSection(id, b));
    // else omitted → recorded in the ledger, not emitted
  }

  parts.push(renderSection("decision-ledger", renderLedger(ledger)));
  return parts.join("\n");
}
