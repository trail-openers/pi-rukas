#!/usr/bin/env bun
/**
 * ci-shard-split — the readers behind `test-ci-shard-coverage.ts` (#2425, epic
 * #2424 item 1b), kept side-effect-free so a canary can call them on a mutated
 * workflow string without running the gate that reads the real file.
 *
 * `.github/workflows/ci.yml` is a gate file, so it is never written to mutate
 * these readers: every mutant here is built in memory from the shipped text and
 * thrown away. Splitting the readers out of the test is what makes that
 * possible — a test whose module body reads the workflow cannot be imported by
 * its own canary, because importing it runs the gate.
 */

/** Read the matrix width out of the workflow: `matrix:` → `shard:` → a flow
 * sequence of integers. Null when the shape is absent or unreadable — a caller
 * that treated an unreadable roster as width 4 would report the split it was
 * supposed to be checking. */
export function matrixShardKeys(text: string): number[] | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^[ \t]*matrix:\s*$/.test(l));
  if (at < 0) return null;
  for (const line of lines.slice(at + 1)) {
    const m = /^[ \t]*shard:\s*\[([^\]]*)\]\s*$/.exec(line);
    if (!m) continue;
    const keys = (m[1] ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    if (keys.length === 0 || !keys.every((k) => /^[0-9]+$/.test(k))) return null;
    return keys.map(Number);
  }
  return null;
}

/** Read the modulus out of the workflow's awk split expression, `NR % 4 == s`. */
export function splitModulus(text: string): number | null {
  const m = /\bawk\b[^\n]*'NR\s*%\s*([0-9]+)\s*==\s*s'/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * The shard assignment of a sorted list under a modulus: index k (0-based) of
 * the sorted offline list belongs to shard `(k + 1) % modulus`, which is awk's
 * `NR % 4 == s` over the same list. A caller passes a mutated modulus to ask
 * what a different rule would have done.
 */
export function shardsOf(sorted: readonly string[], modulus: number): string[][] {
  const shards: string[][] = Array.from({ length: modulus }, () => [] as string[]);
  sorted.forEach((file, i) => shards[(i + 1) % modulus]?.push(file));
  return shards;
}

/** Pad a shorter board with empty shards up to `width`: a split narrower than
 * the declared matrix leaves the trailing shards with nothing to run. */
export function padShards(shards: readonly string[][], width: number): string[][] {
  return Array.from({ length: width }, (_, i) => (shards[i] ? [...shards[i]] : []));
}

/** The workflow's enumeration, verbatim: `ls smoke-tests/test-*.ts`, the
 * `-live.ts` exclusion, then a byte-order (C-locale) sort. */
export function offlineSmokeFiles(entries: readonly string[]): string[] {
  return entries
    .filter((name) => /^test-[^/]+\.ts$/.test(name) && !/-live\.ts$/.test(name))
    .sort((a, b) => {
      // Byte order, which is what `LC_ALL=C sort` means. For the ASCII names
      // here that agrees with the default code-unit sort; the comparator is the
      // rule, the agreement is incidental, and the gate's canary proves the
      // rule fires on a name pair where they differ.
      return Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8"));
    });
}

/**
 * The failures for one (offline list, shard assignment) pair. Three verdicts,
 * each with its own wording because they are different mistakes and a reader
 * that reported two of them alike would let one pass as the other:
 *
 * - `is empty` — a shard ran no test and passed anyway (the vacuous green).
 * - `lands in no shard` — a file no shard ran.
 * - `lands in both shard` — a file two shards ran.
 */
export function shardCoverageFailures(
  offline: readonly string[],
  shards: readonly (readonly string[])[],
): string[] {
  const fails: string[] = [];
  const seen = new Map<string, number>();
  shards.forEach((shard, k) => {
    if (shard.length === 0) fails.push(`shard ${k} is empty — it ran no test and passed`);
    for (const f of shard) {
      const prior = seen.get(f);
      if (prior !== undefined) fails.push(`${f} lands in both shard ${prior} and shard ${k}`);
      seen.set(f, k);
    }
  });
  for (const f of offline) if (!seen.has(f)) fails.push(`${f} lands in no shard`);
  return fails;
}
