/**
 * ledger — the decision ledger for pi-rukas's AGENTS.md.
 *
 * ## Why a git-tracked sidecar, not in-file
 *
 * The ledger is a **per-repo fact that must travel with the repo**. The
 * sidecar at `.pi/agents-md-state.json` is **git-tracked** (NOT gitignored —
 * a smoke test asserts `git check-ignore` exits non-zero on it, guarding the
 * "travels with the repo across checkouts" property), so the decisions
 * persist with the AGENTS.md they govern: a fresh checkout carries both the
 * rendered file AND the sidecar, and a second, divergent decision can never
 * be made in a checkout that has forgotten the first.
 *
 * The rendered AGENTS.md itself stays pure prose — the ledger's provenance,
 * dates, and omission reasons live in the sidecar, never in the rendered
 * bytes. A pre-M1 repo that still carries an in-file `decision-ledger`
 * section is migrated on the first update: its rows are read once, moved
 * into the sidecar, and the section is removed from the file.
 *
 * ## Row model
 *
 * One object per decision, in a JSON array. The provenance field is what
 * separates the two kinds of row, and the asymmetry is the whole design:
 *
 *   - `{"provenance": "auto"}` — re-derivable from the repository. The next
 *     render recomputes it and **silently supersedes** the row if the
 *     derivation changed; no operator is involved because nothing was decided
 *     by a human.
 *   - `{"provenance": "asked"}` — the operator chose, overriding the
 *     auto-derivation. This row is **sticky**: a later render must not
 *     rewrite it just because the environment drifted. Drift on an `asked`
 *     row is a **warning** surfaced by `check`, never an automatic change.
 *
 * The date is a provenance stamp, not content: two renders of the same facts
 * produce different ledger dates, so the sidecar is excluded from the
 * pure-render `Buffer.equals` idempotency assertion (see renderer.ts).
 */

import { SectionError } from "./section-detect.ts";

// The ledger's corruption-refusal error type. Pre-#681 M2 this was `MarkerError`
// (imported from the now-deleted markers.ts); the name was renamed to
// `SectionError` because the ledger no longer validates HTML-comment markers —
// it validates its own row format, and the "corruption is an error, never a
// guess" invariant is carried over verbatim.
const MarkerError = SectionError;

export type LedgerProvenance = "auto" | "asked" | "detected";

export interface LedgerRow {
  key: string;
  value: string;
  provenance: LedgerProvenance;
  date: string; // YYYY-MM-DD, the day the row was written
}

/**
 * Serialize a list of ledger rows into the sidecar file format: a JSON array
 * of `{key, value, provenance, date}` objects. Deterministic byte order: the
 * array order is preserved and each object's keys are in the fixed order
 * `key`, `value`, `provenance`, `date`, so two renders of the same rows
 * produce byte-identical sidecar bytes (the idempotency contract).
 *
 * An empty row list serializes to `[]\n` (a valid, empty sidecar).
 */
export function renderLedger(rows: LedgerRow[]): string {
  const out: Record<string, string>[] = rows.map((r) => ({
    key: r.key,
    value: r.value,
    provenance: r.provenance,
    date: r.date,
  }));
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Render a single row to its JSON object literal (one entry of the sidecar
 * array, without the surrounding array syntax). Exported for tests that
 * exercise the per-row serialization contract in isolation.
 *
 * The date contract is asymmetric by design: `detected` rows REQUIRE a date
 * (an agent-derived fact with no timestamp is a programmer error — throw, do
 * not guess). `auto` and `asked` rows tolerate an empty date (existing
 * behaviour unchanged): an `auto` row is re-derivable so its date is a
 * convenience, and an `asked` row's date records when it was asked.
 */
export function renderRow(r: LedgerRow): string {
  if (r.provenance === "detected" && r.date === "") {
    throw new MarkerError(
      `detected ledger row "${r.key}" requires a date (a detected fact is agent-derived and must be timestamped)`,
    );
  }
  return JSON.stringify({
    key: r.key,
    value: r.value,
    provenance: r.provenance,
    date: r.date,
  });
}

const PROV_KINDS: LedgerProvenance[] = ["auto", "asked", "detected"];

/**
 * Parse a sidecar file's bytes back into rows. Throws MarkerError on any
 * malformed shape — the ledger must not silently drop a decision it cannot
 * read, or the next render would "forget" it and re-ask (or re-derive) the
 * very thing an operator already settled.
 *
 * A `detected` row with an empty (or missing) date is corruption (the render
 * side refuses to emit one, so its presence means a hand-edit or a buggy
 * writer) and is refused the same way any malformed row is — never a guess.
 *
 * The empty-string case (a 0-byte sidecar) is NOT an error: it parses to `[]`,
 * which is the legitimate "no rows yet" state (a brand-new createAgent that
 * scaffolded nothing and had no omissions). An unparseable NON-empty sidecar
 * IS refused — see the throw below.
 */
export function parseLedger(body: string): LedgerRow[] {
  const trimmed = body.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new MarkerError(`sidecar is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new MarkerError("sidecar must be a JSON array of ledger rows");
  }
  const rows: LedgerRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new MarkerError("malformed ledger row: not an object");
    }
    const o = entry as Record<string, unknown>;
    const key = typeof o.key === "string" ? o.key : undefined;
    const value = typeof o.value === "string" ? o.value : undefined;
    const provenance = typeof o.provenance === "string" ? o.provenance : undefined;
    const date = typeof o.date === "string" ? o.date : undefined;
    if (
      key === undefined ||
      value === undefined ||
      provenance === undefined ||
      date === undefined
    ) {
      throw new MarkerError(
        `malformed ledger row: missing field(s) in ${JSON.stringify(entry).slice(0, 120)}`,
      );
    }
    if (!PROV_KINDS.includes(provenance as LedgerProvenance)) {
      throw new MarkerError(`malformed ledger row: unknown provenance "${provenance}"`);
    }
    if (provenance !== "auto" && date === "") {
      throw new MarkerError(
        `malformed ledger row (${provenance} row missing date): ${JSON.stringify(entry).slice(0, 120)}`,
      );
    }
    rows.push({ key, value, provenance: provenance as LedgerProvenance, date });
  }
  return rows;
}

/**
 * Upsert `row` into `rows` by key. Same-key rows are replaced IN PLACE — the
 * order of the surviving rows is preserved (an `asked` row keeps its position
 * rather than jumping to the end, which would make diffs noisy). Returns a new
 * array; never mutates the input.
 */
export function upsertRow(rows: LedgerRow[], row: LedgerRow): LedgerRow[] {
  const idx = rows.findIndex((r) => r.key === row.key);
  if (idx === -1) return [...rows, row];
  const out = rows.slice();
  out[idx] = row;
  return out;
}

/**
 * Merge new auto-derived rows over the existing ledger. Also collapses
 * duplicate keys: if the existing ledger has multiple rows with the same key
 * (which can happen when a manual edit creates a duplicate), only the first
 * is kept. This is how `update` repairs a check-1 (duplicate-ledger-key)
 * finding: the next write collapses the dups, and a subsequent check-0
 * confirms.
 *
 * The rules:
 *   - an existing `asked` row is NEVER overwritten by an `auto` row (sticky).
 *   - an existing `auto` row is superseded by a new `auto` row only when the
 *     value changed; an unchanged auto row is kept (date preserved) so a
 *     re-render does not churn the ledger for no reason.
 *   - a new `auto` row for an unknown key is appended.
 *
 * The `asked` row wins on a key collision: the human decision is the record.
 */
export function mergeAutoRows(existing: LedgerRow[], auto: LedgerRow[]): LedgerRow[] {
  // 1. Collapse duplicate keys: first occurrence wins.
  const seen = new Set<string>();
  const collapsed: LedgerRow[] = [];
  for (const r of existing) {
    if (!r) continue;
    if (seen.has(r.key)) continue; // duplicate — skip
    seen.add(r.key);
    collapsed.push({ ...r });
  }

  // 2. Merge auto rows over the collapsed ledger.
  const out = collapsed;
  for (const a of auto) {
    const i = out.findIndex((r) => r.key === a.key);
    if (i === -1) {
      out.push({ ...a });
    } else {
      const cur = out[i];
      if (!cur) continue;
      if (cur.provenance === "asked" || cur.provenance === "detected") continue; // sticky — never auto-overwrite
      if (cur.value !== a.value) {
        out[i] = { ...a }; // value changed → supersede
      }
      // value identical → keep the existing row, date and all
    }
  }
  return out;
}

/**
 * Find keys where an `asked` row has drifted from a fresh auto-derivation.
 *
 * Drift here means: the operator chose value X, but the repository now
 * auto-derives value Y ≠ X. This is a WARNING, not an error — the operator's
 * choice stands; `check` reports it so a human can decide whether to re-ask.
 */
export function driftWarnings(
  existing: LedgerRow[],
  auto: LedgerRow[],
): { key: string; asked: string; derived: string }[] {
  const out: { key: string; asked: string; derived: string }[] = [];
  for (const a of auto) {
    const cur = existing.find((r) => r.key === a.key);
    if (cur && cur.provenance === "asked" && cur.value !== a.value) {
      out.push({ key: a.key, asked: cur.value, derived: a.value });
    }
  }
  return out;
}

/**
 * Merge omission rows into the existing ledger. Each omission becomes a row
 * with key `omit:<id>` and the omission reason as value, provenance auto.
 */
export function mergeOmissionRows(
  merged: LedgerRow[],
  omitted: { id: string; reason: string }[],
  today: string,
): LedgerRow[] {
  return omitted.reduce(
    (out, o) =>
      upsertRow(out, { key: `omit:${o.id}`, value: o.reason, provenance: "auto", date: today }),
    merged,
  );
}

// ---------------------------------------------------------------------------
// Legacy markdown-table parser (pre-M1 in-file decision-ledger spans only)
// ---------------------------------------------------------------------------

const LEGACY_ROW_RE =
  /^\|\s*([^\s|][^|]*?)\s*\|\s*(\S[^|]*?)\s*\|\s*\[(auto|asked|detected)(?::([^\]]*))?\]\s*\|$/;

const LEGACY_PROV_PREFIX: Record<"asked" | "detected", string> = {
  asked: "operator,",
  detected: "agent,",
};

const LEGACY_PROV_BARE: Record<"asked" | "detected", string> = {
  asked: "operator",
  detected: "agent",
};

/**
 * Parse the LEGACY markdown-table format of the in-file decision-ledger span
 * (pre-M1). This is used ONLY for migration: a pre-M1 repo that still has an
 * in-file `decision-ledger` section is read once, its rows are migrated to
 * the sidecar, and the section is removed from the file. After migration,
 * all future reads/writes use the JSON sidecar format (`parseLedger`).
 *
 * Throws MarkerError on a malformed row (same refuse-or-die semantics as
 * `parseLedger`).
 */
export function parseLegacyMarkdownLedger(body: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (/^<!--/.test(t)) continue;
    if (/^\| key \|/.test(t)) continue;
    if (/^\|\s*-{2,}/.test(t)) continue;
    const m = t.match(LEGACY_ROW_RE);
    if (!m) {
      throw new MarkerError(`malformed legacy ledger row: ${t}`);
    }
    const provKind = (m[3] ?? "") as LedgerProvenance;
    const provExtra = m[4];
    let date = "";
    if (provExtra !== undefined && provExtra !== "") {
      const prefix =
        provKind === "asked"
          ? LEGACY_PROV_PREFIX.asked
          : provKind === "detected"
            ? LEGACY_PROV_PREFIX.detected
            : "";
      date = provExtra.startsWith(prefix)
        ? provExtra.slice(prefix.length).trim()
        : provExtra.trim();
    }
    const bareToken = provKind === "asked" ? LEGACY_PROV_BARE.asked : LEGACY_PROV_BARE.detected;
    if (provKind !== "auto" && (date === "" || date === bareToken)) {
      throw new MarkerError(`malformed legacy ledger row (${provKind} row missing date): ${t}`);
    }
    rows.push({
      key: (m[1] ?? "").trim(),
      value: (m[2] ?? "").trim(),
      provenance: provKind,
      date,
    });
  }
  return rows;
}
