# /audit Contract Examples

Canonical non-runtime examples for the structured JSON shapes referenced by `pi-prompts/audit.md` and smoke-tested in `extension/smoke-tests/test-audit.ts`.

## Standards Discovery Output Shape

```json
{
  "discovery_mode": "complete",
  "limitations": [],
  "standards": {
    "documented": [
      {
        "source": "README.md",
        "summary": "Run bun run check before returning",
        "evidence": "README.md:42"
      }
    ],
    "enforced": [],
    "inferred": [],
    "heuristic": []
  },
  "quality_gates": [
    {
      "gate": "bun run check",
      "source": "extension/.npmrc"
    }
  ],
  "architecture_patterns": [],
  "conflicts": []
}
```

## Merged Audit Report Shape

```json
{
  "discovery_mode": "complete",
  "limitations": [],
  "summary": {
    "critical": 0,
    "high": 1,
    "medium": 0,
    "low": 0,
    "passes_completed": 3
  },
  "findings": [
    {
      "category": "test-gap",
      "severity": "high",
      "confidence": "high",
      "standard_source": "documented",
      "standard_description": "Offline smoke tests must cover merged finding/report shape",
      "observed_deviation": "The smoke test only checked for generic substrings.",
      "evidence": "extension/smoke-tests/test-audit.ts:1",
      "suggested_action": "Assert a parsed JSON finding object and report wrapper."
    }
  ]
}
```

## Partial-Failure Graceful Degradation Shape

```json
{
  "discovery_mode": "partial",
  "limitations": ["architecture pass unavailable"],
  "summary": {
    "critical": 0,
    "high": 0,
    "medium": 1,
    "low": 0,
    "passes_completed": 2,
    "total_passes": 3
  },
  "pass_failures": [
    {
      "pass": "architecture",
      "error": "colgrep unavailable"
    }
  ],
  "findings": [
    {
      "category": "quality-gate",
      "severity": "medium",
      "confidence": "high",
      "standard_source": "enforced",
      "standard_description": "The audit should degrade gracefully when one pass fails.",
      "observed_deviation": "One pass failed, but the merged report still contains the remaining findings.",
      "evidence": "pi-prompts/audit.md:1",
      "suggested_action": "Surface the failure and continue synthesizing the successful passes."
    }
  ]
}
```