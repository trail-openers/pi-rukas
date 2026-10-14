/**
 * lens-exec — re-export of the shared executor, kept so existing importers
 * (the lens review, the driver's git reads) need no change. The implementation
 * lives in exec.ts, which has no driver imports.
 */
export { type ExecOpts, type ExecResult, execp } from "./exec.ts";
