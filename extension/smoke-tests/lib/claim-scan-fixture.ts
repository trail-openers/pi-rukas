/**
 * The nessie #658 diff that both claim-scan suites read.
 *
 * Two defects shipped past all six lenses: a docs paragraph that contradicted
 * another seventy lines below it, and invented hardware specs ("Intel i7, 64 GB
 * RAM, 2 TB NVMe") with no source anywhere in the repository. The specs are what
 * the claim scan exists to catch, and both suites turn on this one diff —
 * `test-claim-scan-rules.ts` on the extraction/grounding rules, `test-claim-scan.ts`
 * on what the gate reports. Shared rather than duplicated so a fixture edit
 * cannot make one suite green about a diff the other no longer sees.
 */
export const NESSIE_DIFF = `diff --git a/docs/deployment.md b/docs/deployment.md
--- a/docs/deployment.md
+++ b/docs/deployment.md
@@ -155,2 +155,4 @@
 Hardware requirements
+The reference host is an Intel i7 with 64 GB RAM and 2 TB of NVMe storage.
+Deployment is verified on that configuration before each release.
`;
