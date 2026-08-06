/**
 * test-invariant-scan — offline smoke tests for the type-widening scanner.
 *
 * Issue #279 — verify the scanner detects the expected widening patterns
 * and fires correctly on fixture diffs. All tests are offline (no CI, no LLM).
 */

import { scanTypeWidening } from "../src/invariant-scan.ts";
import assert from "node:assert/strict";

/** Rust option widening (vipune ea8c836 shape: `T` → `Option<T>` or `T?`) */
function testRustOptionWidening() {
  const diff = `--- a/src/lib.rs
+++ b/src/lib.rs
@@ -10,3 +10,3 @@
-    embedder: EmbeddingEngine,
+    embedder: Option<EmbeddingEngine>,
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1, "should detect exactly one Rust option widening");
  const f = findings[0];
  assert.strictEqual(f.kind, "option-widening-rust");
  assert.strictEqual(f.file, "src/lib.rs");
  assert.ok(f.line !== undefined);
  assert.ok(f.after?.includes("Option<EmbeddingEngine>"));
  console.log("✓ testRustOptionWidening");
}

/** Rust `T?` shorthand */
function testRustOptionShorthand() {
  const diff = `--- a/src/lib.rs
+++ b/src/lib.rs
@@ -5,3 +5,3 @@
-    value: String,
+    value: String?,
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "option-widening-rust");
  console.log("✓ testRustOptionShorthand");
}

/** TypeScript `| null` widening */
function testTsNullWidening() {
  const diff = `--- a/src/types.ts
+++ b/src/types.ts
@@ -2,3 +2,3 @@
-  value: string;
+  value: string | null,
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "option-widening-ts");
  assert.strictEqual(findings[0].file, "src/types.ts");
  console.log("✓ testTsNullWidening");
}

/** TypeScript `| undefined` widening */
function testTsUndefinedWidening() {
  const diff = `--- a/src/types.ts
+++ b/src/types.ts
@@ -4,3 +4,3 @@
-  id: number;
+  id: number | undefined,
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "option-widening-ts");
  console.log("✓ testTsUndefinedWidening");
}

/** TypeScript optional property (`?:`) */
function testTsOptionalProperty() {
  const diff = `--- a/src/types.ts
+++ b/src/types.ts
@@ -3,3 +3,3 @@
   name: string;
-  age: number;
+  age?: number;
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "optional-property");
  assert.strictEqual(findings[0].before, "age");
  assert.ok(findings[0].after?.includes("age?:"));
  console.log("✓ testTsOptionalProperty");
}

/** Removed `readonly` */
function testRemovedReadonly() {
  const diff = `--- a/src/config.ts
+++ b/src/config.ts
@@ -8,3 +8,3 @@
-  readonly apiKey: string;
+  apiKey: string,
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "removed-readonly");
  assert.strictEqual(findings[0].before, "readonly");
  console.log("✓ testRemovedReadonly");
}

/** Removed `final` (Java-style, may appear in comments/docs) */
function testRemovedFinal() {
  const diff = `--- a/module.rs
+++ b/module.rs
@@ -2,3 +2,3 @@
-    // final binding
+    // binding
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "removed-readonly");
  console.log("✓ testRemovedFinal");
}

/** Removed `const` (in SQL or similar contexts) */
function testRemovedConst() {
  const diff = `--- a/schema.sql
+++ b/schema.sql
@@ -4,3 +4,3 @@
-    value TEXT NOT NULL,
+    value TEXT NOT NULL, -- was const
`;
  // SQL files are not scanned, so should be no findings
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 0);
  console.log("✓ testRemovedConst");
}

/** Type erasure to `any` */
function testTypeErasureAny() {
  const diff = `--- a/src/types.ts
+++ b/src/types.ts
@@ -1,3 +1,3 @@
-  result: Result<string>;
+  result: any,
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "type-erasure");
  assert.strictEqual(findings[0].after, "any");
  console.log("✓ testTypeErasureAny");
}

/** Type erasure to `unknown` */
function testTypeErasureUnknown() {
  const diff = `--- a/src/types.ts
+++ b/src/types.ts
@@ -3,3 +3,3 @@
-  payload: JsonObject,
+  payload: unknown,
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "type-erasure");
  console.log("✓ testTypeErasureUnknown");
}

/** Interface{} erasure (Go-style) */
function testTypeErasureInterface() {
  const diff = `--- a/types.go
+++ b/types.go
@@ -2,3 +2,3 @@
-    Value string
-    Value interface{}
`;
  // Go files are not scanned (only .rs, .ts, .tsx, .js, .jsx)
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 0);
  console.log("✓ testTypeErasureInterface");
}

/** Removed `assert!` (Rust) */
function testRemovedAssertRust() {
  const diff = `--- a/src/engine.rs
+++ b/src/engine.rs
@@ -15,3 +15,3 @@
-    assert!(self.is_ready());
-    // is_ready check
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "removed-assert");
  assert.strictEqual(findings[0].before, "assert!(");
  console.log("✓ testRemovedAssertRust");
}

/** Removed `debug_assert!` (Rust) */
function testRemovedDebugAssertRust() {
  const diff = `--- a/src/utils.rs
+++ b/src/utils.rs
@@ -8,3 +8,3 @@
-    debug_assert!(x > 0);
-    // x assumed positive
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "removed-assert");
  console.log("✓ testRemovedDebugAssertRust");
}

/** Removed `assert()` (TS/JS) */
function testRemovedAssertTs() {
  const diff = `--- a/src/assert.ts
+++ b/src/assert.ts
@@ -5,3 +5,3 @@
-    assert(value !== null);
-    // value used
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "removed-assert");
  console.log("✓ testRemovedAssertTs");
}

/** Removed `pub fn` -> `fn` (Rust visibility narrowing) */
function testRemovedPubFn() {
  const diff = `--- a/src/lib.rs
+++ b/src/lib.rs
@@ -10,3 +10,3 @@
-    pub fn process(&self) -> Result<()> {
-    fn process(&self) -> Result<()> {
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "removed-pub");
  console.log("✓ testRemovedPubFn");
}

/** Removed `pub struct` -> `struct` */
function testRemovedPubStruct() {
  const diff = `--- a/src/types.rs
+++ b/src/types.rs
@@ -1,3 +1,3 @@
-    pub struct Config {
-    struct Config {
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "removed-pub");
  console.log("✓ testRemovedPubStruct");
}

/** Removed `mut` (Rust mutability check) */
function testRemovedMut() {
  const diff = `--- a/src/engine.rs
+++ b/src/engine.rs
@@ -20,3 +20,3 @@
-    let mut state = self.state.lock().unwrap();
-    let state = self.state.lock().unwrap();
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, "removed-mut");
  console.log("✓ testRemovedMut");
}

/** Generic widening: `T<U>` → `T<any>` */
function testGenericWideningAny() {
  const diff = `--- a/src/types.ts
+++ b/src/types.ts
@@ -2,3 +2,3 @@
-  result: Result<string>,
+  result: Result<any>,
`;
  const findings = scanTypeWidening(diff);
  // The seven pattern classes are independent detectors, not a partition:
  // `Result<any>` is BOTH type erasure to `any` and generic widening to
  // `T<any>`, so both fire on the one line. Asserting `length === 1` claimed
  // an exclusivity the module never documented. Pin the overlap instead, so
  // it is intended behaviour rather than an accident nobody looked at.
  const generic = findings.filter((f) => f.kind === "generic-widening");
  assert.strictEqual(generic.length, 1, "exactly one generic-widening finding");
  assert.strictEqual(generic[0].after, "Result<any>");
  assert.strictEqual(generic[0].file, "src/types.ts");
  assert.ok(
    findings.some((f) => f.kind === "type-erasure"),
    "type-erasure co-fires on `any` — overlapping classifiers are by design",
  );
  assert.strictEqual(findings.length, 2, "and no OTHER class fires on this line");
  console.log("✓ testGenericWideningAny");
}

/** Precision: unrelated diff should not fire */
function testPrecisionUnrelatedDiff() {
  const diff = `--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # Project

 Updated docs.
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 0, "unrelated diff should produce no findings");
  console.log("✓ testPrecisionUnrelatedDiff");
}

/** Precision: code comment change only */
function testPrecisionCommentOnly() {
  const diff = `--- a/src/lib.rs
+++ b/src/lib.rs
@@ -5,3 +5,3 @@
-    // Old comment
-    // New comment
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 0);
  console.log("✓ testPrecisionCommentOnly");
}

/** Precision: formatting only (no widening) */
function testPrecisionFormattingOnly() {
  const diff = `--- a/src/types.ts
+++ b/src/types.ts
@@ -1,4 +1,4 @@
-export interface Config {
-export interface Config {
   apiKey: string;
   timeout: number;
 }`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 0);
  console.log("✓ testPrecisionFormattingOnly");
}

/** Multiple findings in one diff */
function testMultipleFindings() {
  const diff = `--- a/src/lib.rs
+++ b/src/lib.rs
@@ -10,3 +10,3 @@
-    embedder: EmbeddingEngine,
+    embedder: Option<EmbeddingEngine>,
--- a/src/types.ts
+++ b/src/types.ts
@@ -2,3 +2,3 @@
-  value: string;
+  value: string | null,
@@ -5,3 +5,3 @@
-  readonly apiKey: string;
+  apiKey: string,
`;
  const findings = scanTypeWidening(diff);
  assert.ok(findings.length >= 2, "should detect multiple findings");
  const rustFinding = findings.find((f) => f.kind === "option-widening-rust");
  const tsNullFinding = findings.find((f) => f.kind === "option-widening-ts");
  const readonlyFinding = findings.find((f) => f.kind === "removed-readonly");
  assert.ok(rustFinding, "should detect Rust option widening");
  assert.ok(tsNullFinding, "should detect TS null widening");
  assert.ok(readonlyFinding, "should detect removed readonly");
  console.log("✓ testMultipleFindings");
}

/** Regression: file path parsing for renamed files */
function testRenamedFilePath() {
  const diff = `--- a/old_name.rs
+++ b/new_name.rs
@@ -10,3 +10,3 @@
-    value: String,
+    value: String?,
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].file, "new_name.rs");
  console.log("✓ testRenamedFilePath");
}

/** Regression: line number tracking in hunks */
function testLineNumberTracking() {
  const diff = `--- a/src/file.ts
+++ b/src/file.ts
@@ -8,3 +10,3 @@
     // line 8-10 context
-    const x: string = "hello";
+    const x: string | null = "hello";
     // more context
`;
  const findings = scanTypeWidening(diff);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].file, "src/file.ts");
  assert.ok(findings[0].line !== undefined);
  console.log("✓ testLineNumberTracking");
}

/** Run all tests */
export async function run() {
  testRustOptionWidening();
  testRustOptionShorthand();
  testTsNullWidening();
  testTsUndefinedWidening();
  testTsOptionalProperty();
  testRemovedReadonly();
  testRemovedFinal();
  testRemovedConst();
  testTypeErasureAny();
  testTypeErasureUnknown();
  testTypeErasureInterface();
  testRemovedAssertRust();
  testRemovedDebugAssertRust();
  testRemovedAssertTs();
  testRemovedPubFn();
  testRemovedPubStruct();
  testRemovedMut();
  testGenericWideningAny();
  testPrecisionUnrelatedDiff();
  testPrecisionCommentOnly();
  testPrecisionFormattingOnly();
  testMultipleFindings();
  testRenamedFilePath();
  testLineNumberTracking();
  console.log("\n✓ All invariant-scan tests passed");
}


// The invocation. Without it this file defines its tests and executes none:
// `bun run` prints nothing and exits 0, so the suite counted it as passing
// while the subsystem had zero coverage. A gate that cannot fail is worse
// than no gate — EPIC #328, reproduced inside #279 itself.
run().catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
