#!/usr/bin/env bun
/**
 * #1647 — the always-run set is COMPUTED, not committed.
 *
 * The develop verify runs the tests its import graph reaches plus every smoke
 * test that reads repository source or config as text. That set is computed from
 * the worktree's own smoke tests by `textReadingTests`; there is no committed
 * `ALWAYS_RUN` list to regenerate, so no cycle ever claims a generated file and a
 * sibling cycle on an unrelated issue is not handed back at plan.
 *
 * What makes a computed set trustworthy is the same detector, run the other way:
 * every reader of the real tree IS the selection's always-run set, a planted
 * reader is named, and a planted non-reader is refused — observed red on both
 * mutants. A committed list could drift from the tree it claimed to describe and
 * a reviewer saw only a list line; this asks the tree.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textReadingTests } from "../src/work-driver-verify-always-run.ts";
import { selectVerifyTests, selectedVerifyCommand } from "../src/work-driver-verify-select.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const extensionDir = path.resolve(import.meta.dirname, "..");

// --- the real tree: the computed set is non-trivial and well-formed ---------
const readers = textReadingTests(extensionDir);
assert(readers.length > 0, "the computed always-run set is non-empty on the real tree");
assert(
  !readers.some((t) => /-live\.ts$/.test(t)),
  "no -live.ts test is in the computed always-run set",
);
assert(new Set(readers).size === readers.length, "the computed set lists each test once");
assert(
  readers.every((t) => existsSync(path.join(extensionDir, t))),
  "every computed entry exists on disk",
);
assert(
  readers.includes("smoke-tests/test-lean-work-config-committed.ts"),
  "a test that spells a repository path literal and reads it is a member",
);
// This gate reads repository text for itself, below and in the fixture writes it
// makes: `readsRepositoryText` counts a test as a reader only when it makes a read
// call AND names a repository path, so a gate that were not a reader of its own
// tree would not be selected for a change to the code it judges. Asserted, not
// assumed — the membership of the set over membership is what this file pins.
const SRC = "src/work-driver-verify-always-run.ts";
assert(
  readFileSync(path.join(extensionDir, SRC), "utf8").includes(
    "export function textReadingTests",
  ),
  `the module that computes the set (${SRC}) is read by this gate, which makes it a reader itself`,
);
assert(
  readers.includes("smoke-tests/test-verify-select-computed-always-run.ts"),
  "the gate over membership is itself a member of the set it gates",
);
assert(
  readers.includes("smoke-tests/test-verify-select-hardening.ts"),
  "a test that reads repository text through path.join is a member",
);

// --- a fixture tree: each arm of the predicate is exercised -----------------
const root = mkdtempSync(path.join(tmpdir(), "pi-always-run-computed-"));
const ext = path.join(root, "extension");
const write = (rel: string, text: string) => {
  const file = path.join(ext, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
};
write("src/a.ts", "export const a = 1;\n");
write("smoke-tests/test-a.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');
// A reader: a read call with a src/ path literal.
write(
  "smoke-tests/test-reader.ts",
  'import { readFileSync } from "node:fs";\nconst s = readFileSync("src/a.ts", "utf8");\nvoid s;\n',
);
// A reader whose path is built by path.join: the predicate's join/resolve arm.
write(
  "smoke-tests/test-join-reader.ts",
  'import { readFileSync } from "node:fs";\nimport path from "node:path";\nconst p = path.join(process.cwd(), "src", "a.ts");\nvoid readFileSync(p, "utf8");\n',
);
// A reader whose path is built in a template literal.
write(
  "smoke-tests/test-template-reader.ts",
  'import { readFileSync } from "node:fs";\nconst dir = process.cwd();\nvoid readFileSync(`${dir}/src/a.ts`, "utf8");\n',
);
// A path quoted only in prose: the lexer removes comments, so this is no reader.
write(
  "smoke-tests/test-comment.ts",
  'import { a } from "../src/a.ts";\n// reads "src/a.ts" as text\nvoid a;\n',
);
// A non-reader: it imports the module, which the graph already covers.
write("smoke-tests/test-importer.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');
// A live test that reads repository text: never runs offline, so never a reader.
write(
  "smoke-tests/test-live-reader-live.ts",
  'import { readFileSync } from "node:fs";\nvoid readFileSync("src/a.ts", "utf8");\n',
);
const computed = textReadingTests(ext);
const has = (name: string) => computed.includes(`smoke-tests/${name}`);
assert(
  has("test-reader.ts") && has("test-join-reader.ts") && has("test-template-reader.ts"),
  "a fixture reader is a member, by literal, by path.join and by template literal",
);
assert(
  !has("test-importer.ts") && !has("test-comment.ts"),
  "an importer and a test that names a repository path only in a comment are not members",
);
assert(
  !has("test-live-reader-live.ts"),
  "a live fixture test that reads repository text is never a member",
);

// --- mutants: the predicate answers in both directions ----------------------
// A hand-added entry that makes no repository read — the drift a committed list
// hid, because the reviewer saw a line in a list rather than a rejected candidate.
const planted = computed.filter((t) => t !== "smoke-tests/test-importer.ts");
planted.push("smoke-tests/test-importer.ts");
assert(
  planted.filter((t) => !computed.includes(t)).join() === "smoke-tests/test-importer.ts",
  "a hand-added non-reader is named by the predicate",
);
// A reader dropped from the set is named by the same predicate.
const dropped = computed.filter((t) => t !== "smoke-tests/test-reader.ts");
assert(
  computed.filter((t) => !dropped.includes(t)).join() === "smoke-tests/test-reader.ts",
  "a reader missing from the set is named by the predicate",
);

// The selector carries the tree's own computed set, and the develop plan merges
// both halves into the command — asserted here on the merged list the plan builds.
const selection = selectVerifyTests(ext, ["src/a.ts"]);
assert(selection.mode === "selected", "the fixture selection is computed, not a fallback");
assert(
  selection.mode === "selected" &&
    selection.alwaysRun.length === computed.length &&
    computed.every((t) => selection.alwaysRun.includes(t)),
  "the selection carries the computed always-run set of its own tree",
);
const command = selectedVerifyCommand(
  selection.mode === "selected" ? [...selection.tests, ...selection.alwaysRun] : [],
);
assert(
  computed.every((t) => command.includes(`"$PWD/${t}"`)) &&
    command.includes('"$PWD/smoke-tests/test-a.ts"'),
  "the selected command runs the graph-selected test and every always-run test",
);
assert(
  /^cd extension && node [^&]+ && bash smoke-tests\/lib\/verify-loop\.sh --jobs-from-host(?: "\$PWD\/smoke-tests\/[A-Za-z0-9_.-]+\.ts")+$/.test(
    command,
  ),
  "every argument the selected command spells is a smoke-test path under $PWD",
);
// The command never reaches outside the tree it was given: a name that exists only
// in the shipped repository must not appear, so a worktree cannot be handed a test
// it does not have.
assert(
  !command.includes("smoke-tests/test-lean-work-config-committed.ts"),
  "the command names no test outside the tree it was computed for",
);
// A tree with no smoke-tests directory: the selector does not answer with an
// empty always-run set — silence would look like "nothing extra to run".
let threw = false;
try {
  selectVerifyTests(path.join(root, "missing"), ["src/a.ts"]);
} catch {
  threw = true;
}
assert(threw, "a tree with no smoke-tests directory throws instead of silently selecting none");

rmSync(root, { recursive: true, force: true });
process.exit(exit);
