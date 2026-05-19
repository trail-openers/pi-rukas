# Quality Criteria

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
