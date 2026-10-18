// Derive triage.tsv from validated-oldest.tsv, so no hand-typed tabs can drift into the table.
// A hand-edited TSV fails in the column that decides whether money is spent: the verdict.
//
//   bun gen-triage.js <validated-oldest.tsv> <triage.tsv>
//
// Validates everything first, and writes <triage.tsv> only when there are no problems, through
// a temp file renamed into place. A failed run leaves any existing table untouched.
const fs = require("fs");

const [SRC, OUT] = process.argv.slice(2);
if (!SRC || !OUT) {
  console.error("usage: bun gen-triage.js <validated-oldest.tsv> <triage.tsv>");
  console.error("  <validated-oldest.tsv>  the validated verdict table (input)");
  console.error("  <triage.tsv>            the triage table the runner reads (output, replaced on success)");
  process.exit(2);
}

const HEAD = [
  "issue", "title-bucket", "files-likely-touched", "blast-radius",
  "depends-on", "collides-with-live", "verdict", "blocked-reason", "effort",
];

// The validated verdicts are not the triage vocabulary. Map explicitly and loudly: an unmapped
// verdict is an error, never a default to `ready`, because a wrong `ready` spends a cycle.
const MAP = {
  VALID: (r) => (r["blast-radius"] === "shared-infra" ? "needs-human" : "ready"),
  "STALE-ALREADY": () => "park-stale",
  "STALE-PREMISE": () => "park-stale",
  THIN: () => "park-wont-merge",
  "NEEDS-HUMAN": () => "needs-human",
};

// A free-text cell may carry a tab, CR or LF; any of them would split the row or forge one.
const clean = (v) => String(v ?? "").replace(/[\t\r\n]/g, " ");

const src = fs.readFileSync(SRC, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
const head = src[0].split("\t");
const rows = [];
const problems = [];

src.slice(1).forEach((l) => {
  const cells = l.split("\t");
  const r = {};
  head.forEach((h, i) => { r[h] = (cells[i] || "").trim(); });
  // hasOwn, not a bare lookup: "constructor" would otherwise resolve to Object.prototype.
  const mapper = Object.prototype.hasOwnProperty.call(MAP, r.verdict) ? MAP[r.verdict] : undefined;
  if (!mapper) { problems.push(`issue ${r.issue}: no mapping for verdict '${r.verdict}'`); return; }
  rows.push([
    clean(r.issue),
    // The bucket comes from the source table's own bucket column, or "other". Never inferred
    // from a path: a guessed bucket reads as a judgement.
    clean(r.bucket || "other"),
    clean(r["files-likely-touched"] || "-"),
    clean(r["blast-radius"] || "unknown"),
    clean(r["depends-on"] || ""),
    "",
    clean(mapper(r)),
    clean((r.reason || "").slice(0, 200)),
    clean(r.effort || "-"),
  ]);
});

// Policy runs in a FIXED ORDER, iterated to a fixed point: a dependency pass that ran before
// the shared-infra pass once left a dependent `ready` beside its own unresolved blocker.
const demote = (r, verdict, reason) => {
  if (r[6] === "ready") { r[6] = verdict; r[7] = reason; }
};

// Pass A: shared-infra and cross-module work is serialised by policy. The runtime fence only
// sees live claims, so two such issues queued together would both spawn.
let infraSeen = false;
rows.forEach((r) => {
  if (r[6] !== "ready") return;
  if (r[3] === "shared-infra" || r[3] === "cross-module") {
    if (infraSeen) demote(r, "needs-human", "second shared-infra/cross-module issue in the queue -- run alone, after the first merges");
    else infraSeen = true;
  }
});

// Passes B and C run in one loop until nothing changes. Demotion is one-way, so it terminates.
const byIssue = new Map(rows.map((r) => [r[0], r]));
let changed = true;
while (changed) {
  changed = false;

  // Pass B: a dependency that is not `ready` makes the dependent not runnable. Computed, not
  // trusted: "blocked on #N" in prose goes stale; this table says whether #N is clear.
  rows.forEach((r) => {
    if (r[6] !== "ready") return;
    // A "-" cell is the blank marker the source tables use for "none", not an issue to look up.
    const depCell = r[4] || "";
    const deps = depCell.trim() === "-" ? [] : depCell.split(/[,\s]+/).filter(Boolean).map((d) => d.replace(/^#/, ""));
    // An unknown dependency is a blocker: it was never judged, so it cannot be assumed clear.
    const blockers = deps.filter((d) => { const dep = byIssue.get(d); return !dep || dep[6] !== "ready"; });
    if (blockers.length) {
      demote(r, "blocked", `depends on ${blockers.join(", ")} which ${blockers.length === 1 ? "is" : "are"} not ready`);
      changed = true;
    }
  });

  // Pass C: two issues touching the same file never share a batch. The runtime fence sees only
  // live claims, so two queued workers over one file would both spawn and conflict.
  // A directory entry claims everything under it, matching the runtime fence.
  const fileOwners = new Map();
  rows.forEach((r) => {
    if (r[6] !== "ready") return;
    const files = (r[2] || "").split(",").map((s) => s.trim()).filter((f) => f && f !== "-");
    const clash = files.flatMap((f) => {
      const hits = [];
      fileOwners.forEach((owner, claimed) => {
        if (owner.issue === r[0]) return;
        if (claimed === f || claimed.startsWith(f + "/") || f.startsWith(claimed + "/")) hits.push(owner);
      });
      return hits;
    });
    if (clash.length) {
      const names = [...new Set(clash.map((c) => c.issue))].join(", ");
      demote(r, "blocked", `overlaps file(s) already claimed by ready issue(s) ${names} in this queue -- run after they merge`);
      changed = true;
      return;
    }
    files.forEach((f) => { if (!fileOwners.has(f)) fileOwners.set(f, { issue: r[0] }); });
  });
}

const text = [HEAD.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n") + "\n";

// Validate the text BEFORE it touches the disk: every line has the header's field count, and the
// row count equals the input's. A mismatch means a cell escaped cleaning, which must not ship.
const lines = text.split("\n").filter((l) => l.length > 0);
const bad = lines.filter((l, i) => i > 0 && l.split("\t").length !== HEAD.length);
const dataRows = lines.length - 1;
const inputRows = src.length - 1;
if (dataRows !== inputRows) problems.push(`row count mismatch: input ${inputRows}, output ${dataRows}`);
if (bad.length) problems.push(`${bad.length} output row(s) do not have ${HEAD.length} fields`);

if (problems.length) {
  console.log(`NOT WRITTEN: ${OUT} left unchanged.`);
  problems.forEach((p) => console.log("  " + p));
  process.exit(1);
}

const tmp = `${OUT}.tmp.${process.pid}`;
fs.writeFileSync(tmp, text);
fs.renameSync(tmp, OUT);

const tally = {};
lines.slice(1).forEach((l) => { const c = l.split("\t"); tally[c[6]] = (tally[c[6]] || 0) + 1; });
console.log("wrote", OUT, "->", dataRows, "rows");
console.log("verdicts:", JSON.stringify(tally));
console.log("ready:", lines.slice(1).filter((l) => l.split("\t")[6] === "ready").map((l) => l.split("\t")[0]).join(", ") || "(none)");
console.log(`OK every row has exactly ${HEAD.length} fields and the row count matches the input`);
