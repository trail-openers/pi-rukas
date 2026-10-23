/**
 * The one place the handoff step's host-signal writer lives.
 *
 * `runHandoff` resolves this binding AT CALL TIME, so a test that needs two
 * writers to disagree points it at its own instrumented writer. A default
 * parameter is not an option: bun's transpiler drops a parameter whose default
 * is the very module-level binding named in it, so the step would silently call
 * the production writer and a test's readings would never be consulted — an
 * assertion about two racing writers would then pass or fail on the disk alone,
 * which is exactly the false green this seam exists to prevent.
 */

import type { DriverContext } from "./work-driver-context.ts";
import { type HostParkRow, recordHostPark } from "./work-driver-park-memory-host.ts";
import type { WorkState } from "./workflow-state.ts";

/** What one write should see: the writer to call, and the readings it holds. */
export interface HostParkWriteOverride {
  /** Stand in for `recordHostPark`, usually to observe or queue its readings. */
  writer?: (ctx: DriverContext, state: WorkState, published: boolean) => Promise<void>;
  /** One reading per read of the write, in call order. */
  readings?: HostParkRow[][];
}

let override: HostParkWriteOverride | undefined;

/**
 * Install the override for the writes `run` performs, and always hand the seam
 * back afterwards — a test's readings must not outlive the one write they
 * describe, because a real cycle running alongside would read them as its own.
 */
export async function withHostParkWrite<T>(
  next: HostParkWriteOverride | undefined,
  run: () => Promise<T>,
): Promise<T> {
  override = next;
  try {
    return await run();
  } finally {
    override = undefined;
  }
}

/** The step's call: the override's writer when one is installed, else the real one. */
export async function callHostParkWriter(
  ctx: DriverContext,
  state: WorkState,
  published: boolean,
): Promise<void> {
  if (override?.writer) return override.writer(ctx, state, published);
  await recordHostPark(ctx, state, published, override?.readings);
}
