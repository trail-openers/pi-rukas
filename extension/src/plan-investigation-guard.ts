/**
 * plan-investigation-guard — the shape guard for a cached /plan dry run (#1377).
 *
 * Split from plan-investigation-cache.ts along the 500-line seam (AGENTS.md §12).
 * One job: decide whether bytes read back from the cache file are well-formed
 * enough for the pipeline to dereference. A malformed or hand-edited entry must
 * be a MISS, never a crash deep inside drafting or filing — and never a verbatim
 * filing of bytes no validator admitted.
 *
 * Two rules beyond "does the field exist", both from the #1377 review:
 *
 *   - **plain object**. An `Object.create({ line })` satisfies a bare `typeof
 *     o.line` while the object has no line of its own. The cache file is JSON,
 *     so `JSON.parse` cannot produce that shape — but the guard is the only
 *     thing standing between a hand-edited file and a filing.
 *   - **own keys only**. `Object.keys` — what the provenance render and the
 *     digest enumerate — ignores the prototype and symbol keys. A guard that
 *     reads inherited bytes while the render reads own ones calls an entry
 *     well-formed and then files something other than what it validated. The
 *     provenance half of this defers to `isProvenanceShape` rather than
 *     restating it: two hand-rolled checks over one object drift, silently.
 */
import type { InvestigationCacheEntry } from "./plan-investigation-cache.ts";
import { isProvenanceShape } from "./plan-provenance.ts";

const isStr = (x: unknown): x is string => typeof x === "string";
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/**
 * A plain object — an `Object` prototype (or a bare `Object.create(null)`) and
 * not an array. This is what excludes the shapes `JSON.parse` of a well-formed
 * file cannot produce but a hand-edited cache file can: an object whose fields
 * live on the prototype rather than on the object itself.
 */
const isPlainObj = (x: unknown): x is Record<string, unknown> => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

/**
 * Every OWN key of an object is an enumerable string key. `JSON.parse` routes a
 * `"__proto__"` member onto the prototype, where `Object.keys` never sees it —
 * which is exactly the inconsistency this rejects: a field the guard reads and
 * the render does not. Symbol keys are excluded too, because
 * `Object.getOwnPropertyNames` does not list them while `hasOwnProperty` accepts
 * them, so a symbol-keyed pair would validate and then never render.
 */
const isOwnKeyed = (o: Record<string, unknown>): boolean =>
  Object.getOwnPropertyNames(o).every((k) => Object.prototype.propertyIsEnumerable.call(o, k)) &&
  Object.getOwnPropertySymbols(o).length === 0;

/** Plain and own-keyed — the pair every nested object in an entry must satisfy. */
const isShape = (x: unknown): x is Record<string, unknown> => isPlainObj(x) && isOwnKeyed(x);

const isToolUse = (x: unknown): boolean =>
  isShape(x) && isStr(x.kind) && isStr(x.text) && isStr(x.angle);

const isFinding = (x: unknown): boolean =>
  isShape(x) &&
  isStr(x.name) &&
  typeof x.ok === "boolean" &&
  isStr(x.text) &&
  Array.isArray(x.toolUses) &&
  x.toolUses.every(isToolUse) &&
  (x.failure === undefined || isStr(x.failure));

const isGap = (x: unknown): boolean =>
  isShape(x) &&
  typeof x.severity === "string" &&
  SEVERITIES.includes(x.severity) &&
  isStr(x.description) &&
  isStr(x.resolution);

const isFact = (x: unknown): boolean => isShape(x) && isStr(x.source) && isStr(x.fact);

const isInventory = (x: unknown): boolean =>
  isShape(x) &&
  Array.isArray(x.memory) &&
  x.memory.every((m) => isShape(m) && isStr(m.content)) &&
  Array.isArray(x.related) &&
  x.related.every(
    (r) => isShape(r) && typeof r.number === "number" && isStr(r.title) && isStr(r.state),
  ) &&
  Array.isArray(x.errors) &&
  x.errors.every(isStr);

const isBarrier = (x: unknown): boolean =>
  isShape(x) &&
  Array.isArray(x.findings) &&
  x.findings.every(isFinding) &&
  Array.isArray(x.neverClaimDisclosure) &&
  x.neverClaimDisclosure.every(isStr) &&
  (x.duplicateRisk === undefined ||
    (isShape(x.duplicateRisk) && isStr(x.duplicateRisk.level) && isStr(x.duplicateRisk.rationale)));

/**
 * The provenance half defers to the ONE validator the feature has, rather than
 * restating its shape here. The drift this prevents is invisible: this guard
 * would call an entry well-formed that `validateProvenance` refuses, and the
 * verbatim filing would render bytes no gate ever admitted.
 */
const isProvenance = (x: unknown): boolean => isProvenanceShape(x);

const isReviewed = (x: unknown): boolean => {
  if (!isShape(x)) return false;
  const { fileable, title, spec, priorContext, failedAngles, labels, provenance } = x;
  return (
    typeof fileable === "boolean" &&
    isStr(title) &&
    isStr(spec) &&
    Array.isArray(priorContext) &&
    priorContext.every(isFact) &&
    (failedAngles === undefined ||
      (Array.isArray(failedAngles) &&
        failedAngles.every((a) => isShape(a) && isStr(a.name) && isStr(a.detail)))) &&
    // #1377: optional on both sides — an entry written before labels existed is
    // well-formed and files with no labels. But when they ARE present they must
    // be the shapes the digest and the create call assume, or a hand-edited
    // entry would send a malformed argv / hash a tuple nothing produced.
    (labels === undefined ||
      (Array.isArray(labels) && labels.every((l) => isStr(l) && l.trim().length > 0))) &&
    (provenance === undefined || isProvenance(provenance)) &&
    // A fileable entry must carry something to file.
    (!fileable || (title.trim().length > 0 && spec.trim().length > 0))
  );
};

/**
 * Whether parsed cache JSON is a well-formed entry — every field the pipeline
 * dereferences, including the barrier's findings and their tool uses, the gaps,
 * the inventory, the reviewed spec and its facts. Exported for the round-trip
 * test; the only production caller is `readEntryAt`.
 */
export function isCacheEntry(x: unknown): x is InvestigationCacheEntry {
  if (!isShape(x)) return false;
  return (
    isStr(x.key) &&
    typeof x.createdAt === "number" &&
    isInventory(x.inventory) &&
    isBarrier(x.barrier) &&
    Array.isArray(x.gaps) &&
    x.gaps.every(isGap) &&
    isReviewed(x.reviewed)
  );
}
