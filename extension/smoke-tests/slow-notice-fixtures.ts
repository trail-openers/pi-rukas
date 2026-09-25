/**
 * #799 — shared fixtures for the slow-notice smoke tests. A temp dir the
 * driver-path tests use as repoRoot (it only needs to exist: the fake
 * dispatchFn never shells out to it). One per process.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const REPO = mkdtempSync(path.join(os.tmpdir(), "pi-ens-799s-"));
