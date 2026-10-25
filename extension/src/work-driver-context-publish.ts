/**
 * work-driver-context-publish — the driver-context fields that steer a
 * driver-authored PUBLISH, split out of `work-driver-context.ts` for the §12 cap.
 *
 * `DriverContext` is one flat object every step reads, so a field cannot live in
 * two places; this module owns these declarations and the interface extends it.
 * What they share: none changes what the cycle BUILDS, each changes what it may
 * say about it.
 */

import type { VisibilityFn } from "./public-hygiene-visibility.ts";

/** The publish-steering fields `DriverContext` inherits. */
export interface DriverPublishContextFields {
  /**
   * #1820 — test seam for the ONE visibility question the driver's handoff publish
   * asks. Production omits it and `gh` answers (a target the question cannot name
   * is public, the fail-closed direction); a fixture that is not testing visibility
   * pins the answer so its verdict cannot depend on the host's `gh` or denylist.
   */
  handoffVisibility?: VisibilityFn;
}
