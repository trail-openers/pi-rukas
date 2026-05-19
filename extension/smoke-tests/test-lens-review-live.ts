#!/usr/bin/env bun
/**
 * Live end-to-end smoke test: fire all six lens children against a tiny
 * synthetic diff and report what each returns. This actually spawns Pi six
 * times in parallel — costs roughly 6× a single dispatch_specialist call.
 *
 * Expect SECURITY to flag the SQL injection; possibly PERFORMANCE / ERROR
 * to flag the unbounded loop; the rest should usually return [].
 */

import { runLensReview } from "../src/lens-review.ts";

const diff = `diff --git a/src/auth.ts b/src/auth.ts
@@ -10,7 +10,15 @@ export async function login(username: string, password: string) {
+  // INSECURE: building SQL by string concatenation
+  const query = "SELECT * FROM users WHERE name = '" + username + "'";
+  const rows = await db.raw(query);
+  if (rows.length === 0) return null;
+  const stored = rows[0].password;
+  for (let i = 0; i < stored.length; i++) {
+    if (stored[i] !== password[i]) return null;
+  }
+  return rows[0];
 }`;

const start = Date.now();
console.log("[test] firing six lenses against synthetic diff...");

const summary = await runLensReview({
  diff,
  context: "New login function with raw SQL and a hand-rolled password compare",
  timeoutMs: 90_000,
});

console.log(`\n[test] wall: ${Date.now() - start}ms`);
console.log(`[test] verdict: ${summary.verdict}`);
console.log(`[test] total findings: ${summary.totalFindings}`);
console.log(`[test] by severity:`, summary.bySeverity);
console.log(`\nper-lens:`);
for (const l of summary.lenses) {
  const tag = l.parseError ? `parseError=${l.parseError}` : `${l.findings.length} findings`;
  console.log(`  ${l.lens.padEnd(16)} ${l.ms}ms   ${tag}`);
  if (l.parseError) {
    console.log(`    note: ${l.parseError}`);
  }
}
console.log(`\nfindings (deduped, sorted):`);
for (const f of summary.findings) {
  console.log(`  [${f.severity}] ${f.lens}  ${f.path}:${f.line} — ${f.title}`);
}
