/**
 * research-timings — per-phase wall-clock timer for the /research driver.
 * Extracted from research-driver.ts to keep the driver under the 500-line
 * cap; behaviour is unchanged.
 */
import type { PlanPhaseTiming } from "./plan-types.ts";

export class PhaseTimer {
  readonly timings: PlanPhaseTiming[] = [];
  private readonly pipelineStart = Date.now();

  async run<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.timings.push({ phase, ms: Date.now() - t0 });
    }
  }

  finish(): PlanPhaseTiming[] {
    return [...this.timings, { phase: "total", ms: Date.now() - this.pipelineStart }];
  }
}
