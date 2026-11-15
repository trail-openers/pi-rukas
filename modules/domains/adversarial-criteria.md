# Quality Criteria

## Evidence, Not Claims

A criterion that requires an action or a measurement is met only by evidence that it executed. A record that round-trips through its own generator is not that evidence: rendering committed bytes from rows the same file already contains proves the renderer is pure, and says nothing about whether the measurement happened or the source it names ever existed.

## Coverage Requirements

| Risk Level | Coverage Required | Examples |
|------------|-------------------|----------|
| Critical | 95%+ | Auth, payments, data deletion, encryption |
| High | 85%+ | User data, APIs, database writes |
| Medium | 80%+ | Internal APIs, services, utilities |
| Low | 70%+ | Documentation, config, formatting |

## Forbidden Bypasses

Flag any of these as violations:
- `# noqa` — must fix the actual issue
- `# type: ignore` — must fix the type error
- `@ts-ignore` — must fix the TypeScript error
- `eslint-disable` without documented justification
