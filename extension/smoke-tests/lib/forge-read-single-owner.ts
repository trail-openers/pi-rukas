/**
 * lib/forge-read-single-owner — retired stub (#2382).
 *
 * The one-owner rows and the duplicate-tool mutant that judges them live in
 * `lib/forge-read-duplicate-mutant.ts`, counted through the single collector in
 * `lib/forge-read-collector.ts`. Nothing imports this file: the file-deletion rule
 * will not let a dispatched child remove it, so it is emptied rather than deleted
 * and goes with the collector's mutant half when that lands.
 */

export {};
