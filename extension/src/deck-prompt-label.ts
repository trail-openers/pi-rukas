/**
 * Short label for the aboveEditor selectable deck rows (#709).
 *
 * The belowEditor deck row (formatRow in dispatch-deck.ts) is the single
 * source of full per-job status detail (elapsed, tool, hint, STALE badge).
 * The aboveEditor list is a compact selection control only, so its rows get
 * a short label: entry label + a short key fragment (e.g. "explore · df8a-1").
 *
 * The key fragment keeps same-role jobs distinguishable (two in-flight
 * "explore" entries still render two distinct rows).
 *
 * The label fallback mirrors entryLabel() in dispatch-deck.ts (e.label ||
 * role[tag] || role) so an empty entry.label never renders as a bare
 * "· <key>" — the role is always present.
 */
import type { RunningState } from "./progress.ts";

/** Job keys come from makeRunId() as ~11-char base36 (e.g. "df8a-1xxxxx"). */
const KEY_FRAGMENT_LEN = 8;

function entryLabel(label: string, state: RunningState): string {
  return label || (state.tag ? `${state.role}[${state.tag}]` : state.role);
}

function keyFragment(key: string): string {
  if (key.length <= KEY_FRAGMENT_LEN) return key;
  return `${key.slice(0, KEY_FRAGMENT_LEN).trimEnd()}…`;
}

export function shortPromptLabel(entry: {
  label: string;
  state: RunningState;
  key: string;
}): string {
  return `${entryLabel(entry.label, entry.state)} · ${keyFragment(entry.key)}`;
}
