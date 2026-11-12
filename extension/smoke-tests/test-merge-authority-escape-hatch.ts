#!/usr/bin/env bun
/**
 * #2181 — the merge authority escape hatch toggle (#380).
 * PI_ENSEMBLE_MERGE_AUTHORITY=0 restores pre-#380 behaviour; the gate is ON by default.
 */

import { mergeAuthorityEnabled } from "../src/work-driver-merge-authority.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
	if (cond) {
		console.log(`✓ ${msg}`);
	} else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

{
	const prev = process.env.PI_ENSEMBLE_MERGE_AUTHORITY;
	process.env.PI_ENSEMBLE_MERGE_AUTHORITY = "0";
	try {
		assert(
			!mergeAuthorityEnabled(),
			"PI_ENSEMBLE_MERGE_AUTHORITY=0 restores pre-#380 behaviour",
		);
	} finally {
		if (prev === undefined) delete process.env.PI_ENSEMBLE_MERGE_AUTHORITY;
		else process.env.PI_ENSEMBLE_MERGE_AUTHORITY = prev;
	}
	assert(mergeAuthorityEnabled(), "and the gate is ON by default");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
