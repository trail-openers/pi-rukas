# Code Review Security Checklist

What to look at, and where to look hardest. This checklist sets review
**attention** — it never assigns a finding's severity. Severity is a claim about
the harm a specific finding causes and the shared rubric in the review prompt
decides it, so a missing rate limit in a payment path is not automatically a
HIGH and a typo in a docs page is not automatically a LOW.

## INPUT HANDLING (every category of file)

- [ ] All HTTP params validated with explicit schema/type
- [ ] Request body size limits enforced
- [ ] File uploads validated: type, size, content
- [ ] Parameterized queries used (NO string concatenation in SQL)
- [ ] Command injection prevented
- [ ] Path traversal prevented
- [ ] Array/list inputs have length limits

## DATA SAFETY (every category of file)

- [ ] No PII in logs (emails, names, IPs)
- [ ] No secrets in logs (API keys, tokens)
- [ ] Error messages sanitized (no stack traces to users)
- [ ] Sensitive data encrypted at rest
- [ ] Connections use TLS/HTTPS only

## CONCURRENCY (worth the most attention)

- [ ] Race conditions checked: check-then-act patterns wrapped in transactions
- [ ] Optimistic locking or SELECT FOR UPDATE for shared resources
- [ ] Rollback on partial failure
- [ ] Connection timeout on all external calls
- [ ] Deadlock prevention: consistent lock ordering

## RESOURCE LIMITS (worth the most attention)

- [ ] Max request body size configured
- [ ] Pagination limits enforced server-side
- [ ] Rate limiting on public endpoints
- [ ] Memory bounds on collections
- [ ] File upload size limits enforced

## AUTH/AUTHZ (worth the most attention)

- [ ] Every protected endpoint has auth middleware
- [ ] User can only access own resources
- [ ] Role checks explicit and consistent
- [ ] Session timeout configured
- [ ] Brute force protection on login endpoints

## Sensitive Data Patterns (Search Regex)

- API keys: `/(sk|pk|api)[_-]?(live|test|key|secret)?[_-]?[a-zA-Z0-9]{20,}/i`
- Credit cards: `/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\b/`
- AWS credentials: `/AKIA[0-9A-Z]{16}/`
