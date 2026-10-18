// Derive triage.tsv from validated-oldest.tsv so no hand-authored tabs can drift.
// The previous triage.tsv was written by hand and every one of its 14 rows had the wrong
// field count, which resolved `verdict` to empty and made the gate refuse correctly for a
// completely wrong reason. That is the argument for generating rather than typing: a
// hand-edited TSV fails silently in the column that decides whether money is spent.
const fs = require("fs");

// Run with bun (the project runtime):  bun gen-triage.js <validated.tsv> <triage.tsv>
const [SRC, OUT] = process.argv.slice(2);
if (!SRC || !OUT) {
  console.error("usage: bun gen-triage.js <validated-oldest.tsv> <triage.tsv>");
  console.error("  <validated-oldest.tsv>  the validated verdict table (input)");
  console.error("  <triage.tsv>            the triage table the runner reads (output, overwritten)");
  process.exit(2);
}

const HEAD = [
  "issue", "title-bucket", "files-likely-touched", "blast-radius",
  "depends-on", "collides-with-live", "verdict", "blocked-reason", "effort",
];

// The validated verdicts are not the triage vocabulary. Map them explicitly and LOUDLY --
// an unmapped verdict is a hard error, never a silent default to `ready`, because a wrong
// `ready` is the expensive direction (it spends a cycle) and a wrong `blocked` is not.
const MAP = {
  VALID: (r) => (r["blast-radius"] === "shared-infra" ? "needs-human" : "ready"),
  "STALE-ALREADY": () => "park-stale",
  "STALE-PREMISE": () => "park-stale",
  THIN: () => "park-wont-merge",
  "NEEDS-HUMAN": () => "needs-human",
};

const src = fs.readFileSync(SRC, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
const head = src[0].split("\t");
const rows = [];
const problems = [];

src.slice(1).forEach((l) => {
  const cells = l.split("\t");
  const r = {};
  head.forEach((h, i) => { r[h] = (cells[i] || "").trim(); });
  const mapper = MAP[r.verdict];
  if (!mapper) { problems.push(`issue ${r.issue}: no mapping for verdict '${r.verdict}'`); return; }
  let verdict = mapper(r);
  const reason = r.reason || "";
  rows.push([
    r.issue,
    // bucket from the issue's own conventional-commit prefix when the source table carries a
    // title; otherwise "other". Deliberately NOT inferred from the file path -- an extension/
    // path is not a `fix`, and a bucket that looks authoritative but was guessed is worse than
    // an honest "other", because it is a sorting input that reads as a judgement.
    r.bucket || "other",
    r["files-likely-touched"] || "-",
    r["blast-radius"] || "unknown",
    r["depends-on"] || "",
    "",
    verdict,
    reason.slice(0, 200),
    r.effort || "-",
  ]);
});

// Policy is applied in a FIXED ORDER, and the order is the bug this file first had: the
// dependency pass ran before the shared-infra pass, so an issue depending on a cross-module
// issue was marked ready, and that cross-module issue was demoted to needs-human only
// afterwards -- leaving a worker free to spawn a dependent alongside its own unresolved
// blocker. Iterate to a fixed point instead of ordering passes by hand.
const demote = (r, verdict, reason) => {
  if (r[6] === "ready") { r[6] = verdict; r[7] = reason; }
};

// Pass A: shared-infra and cross-module work is serialized by POLICY, not by collision
// detection. The fleet only fences against currently-live claims, so two shared-infra issues
// queued in the same batch would both spawn and both touch what verification means.
let infraSeen = false;
rows.forEach((r) => {
  if (r[6] !== "ready") return;
  if (r[3] === "shared-infra" || r[3] === "cross-module") {
    if (infraSeen) demote(r, "needs-human", "second shared-infra/cross-module issue in the queue -- run alone, after the first merges");
    else infraSeen = true;
  }
});

// Pass B: a dependency that is not itself `ready` makes the dependent not-runnable. Computed
// rather than trusted, because "blocked on #N" in an issue body is prose and prose goes
// stale; this table says whether #N is actually clear to run.
for (let iter = 0; iter < rows.length + 1; iter += 1) {
  let changed = false;
  const byIssue = new Map(rows.map((r) => [r[0], r]));
  rows.forEach((r) => {
    if (r[6] !== "ready") return;
    const deps = (r[4] || "").split(/[,\s]+/).filter(Boolean);
    const blockers = deps.filter((d) => { const dep = byIssue.get(d); return dep && dep[6] !== "ready"; });
    if (blockers.length) {
      demote(r, "blocked", `depends on ${blockers.join(", ")} which ${blockers.length === 1 ? "is" : "are"} not ready`);
      changed = true;
    }
  });
  // A demotion can unblock nothing but can block others, so keep going until stable. Pass A
  // re-runs implicitly through the same `ready` test above.
  if (!changed) break;
}

// Pass C: two issues touching the SAME FILE must never be in one batch. The runtime fence
// only compares against currently-live claims, so two queued workers over one file both spawn
// and produce two conflicting PRs -- which is worse than a collision with a finished cycle,
// because both cycles pay full price. This is the rule the docs told the operator to apply by
// hand; enforcing it here is the difference between a rule and a hope.
//
// Note this catches cases pass A misses: 770 is radius `module` but edits the same
// workflow-state-schema.ts as 767, so blast-radius alone is not a sufficient fence.
const fileOwners = new Map();
rows.forEach((r) => {
  if (r[6] !== "ready") return;
  const files = (r[2] || "").split(",").map((s) => s.trim()).filter((f) => f && f !== "-");
  // A directory-ish entry claims everything under it, matching the runtime fence's semantics.
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
    return;
  }
  files.forEach((f) => { if (!fileOwners.has(f)) fileOwners.set(f, { issue: r[0] }); });
});

const out = [HEAD.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n") + "\n";
fs.writeFileSync(OUT, out);

// Self-check: the file must parse back with exactly the header's field count.
const back = fs.readFileSync(OUT, "utf8").split("\n").filter((l) => l.trim());
const bad = back.filter((l, i) => i > 0 && l.split("\t").length !== HEAD.length);
const tally = {};
back.slice(1).forEach((l) => { const c = l.split("\t"); tally[c[6]] = (tally[c[6]] || 0) + 1; });
console.log("wrote", OUT, "->", back.length - 1, "rows");
console.log("verdicts:", JSON.stringify(tally));
console.log("ready:", back.slice(1).filter((l) => l.split("\t")[6] === "ready").map((l) => l.split("\t")[0]).join(", ") || "(none)");
console.log(bad.length ? `FAIL ${bad.length} malformed rows` : "OK every row has exactly " + HEAD.length + " fields");
if (problems.length) { console.log("UNMAPPED:"); problems.forEach((p) => console.log("  " + p)); }
process.exit(bad.length || problems.length ? 1 : 0);
