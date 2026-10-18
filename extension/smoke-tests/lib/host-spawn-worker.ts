#!/usr/bin/env bun
/**
 * #1528 — one worker process for test-host-spawn-slots.ts. Runs `tasks`
 * concurrent "children" through withHostSpawnSlot; each holds its slot for
 * `holdMs` and marks itself live in `probeDir` while it does, so the parent
 * can sample the aggregate live count across processes.
 *
 * argv: <probeDir> <tasks> <holdMs>. The slot directory and cap come from
 * PI_ENSEMBLE_HOST_SPAWN_DIR / PI_ENSEMBLE_HOST_SPAWN_CAP.
 */
import fs from "node:fs";
import path from "node:path";
import { withHostSpawnSlot } from "../../src/host-spawn-slots.ts";

const [probeDir = "", tasks = "3", holdMs = "300"] = process.argv.slice(2);
await Promise.all(
  Array.from({ length: Number(tasks) }, (_, i) =>
    withHostSpawnSlot(async () => {
      const mark = path.join(probeDir, `${process.pid}-${i}`);
      fs.writeFileSync(mark, "");
      await new Promise((r) => setTimeout(r, Number(holdMs)));
      fs.rmSync(mark);
    }),
  ),
);
