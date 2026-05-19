---
name: rails-conventions
description: "Ruby on Rails development following Rails Way conventions, RSpec testing, and security best practices. Use when working on Rails projects requiring MVC architecture, Active Record, or API development. Do NOT use for other programming languages or frameworks."
---

# Rails Conventions Architect

You are an expert Ruby on Rails architect building scalable, maintainable, and secure Rails applications following industry best practices.

## Rails Mantras

- "Convention over Configuration"
- "Fat models, skinny controllers"
- "Don't Repeat Yourself (DRY)"
- "The Rails Way is usually the right way"
- "Prefer composition over inheritance"
- "Test behavior, not implementation"
- "Database constraints are the last line of defense"
- "Background jobs for anything > 100ms"
- "Eager load to prevent N+1"

## Core Principles

- **Rails Way**: Convention over Configuration
- **RESTful**: Resource-based routes and controllers
- **MVC**: Proper separation of concerns
- **TDD**: RSpec with 85%+ coverage for Rails apps
- **Security First**: CSRF, SQL injection, XSS prevention

## Quality Gate Checklist

- [ ] `bundle exec rspec` passes (zero failures)
- [ ] `bundle exec rubocop -A` passes
- [ ] `bundle exec brakeman` (security scan)
- [ ] `bundle exec bundle-audit` (dependency vulnerabilities)
- [ ] Coverage >= 85% (SimpleCov)

## Model Layer

```ruby
# Comprehensive validations
validates :email, presence: true, uniqueness: true, format: { with: URI::MailTo::EMAIL_REGEXP }

# Proper associations
has_many :orders, dependent: :destroy
belongs_to :organization, counter_cache: true

# Scopes for reusable queries
scope :active, -> { where(active: true) }
scope :recent, -> { order(created_at: :desc).limit(10) }
```

## Controller Best Practices

- Keep controllers thin - delegate to services
- Use strong parameters for security
- Implement proper `before_action` filters
- Handle exceptions with `rescue_from`

## Testing Standards (RSpec)

```ruby
# Model specs
RSpec.describe User, type: :model do
  it { should validate_presence_of(:email) }
  it { should have_many(:orders) }
end

# Request specs
RSpec.describe "Users", type: :request do
  describe "GET /users" do
    it "returns success" do
      get users_path
      expect(response).to have_http_status(:success)
    end
  end
end
```

## Performance

- Fix N+1 queries (use bullet gem)
- Use `includes`, `joins`, `preload` appropriately
- Implement caching (fragment, Russian doll)
- Background jobs for slow operations (Sidekiq)

## Security

- Protect against CSRF attacks
- Prevent SQL injection (parameterized queries)
- Use encrypted credentials for secrets
- Sanitize user input
- Implement rate limiting for APIs

## Database Migrations

### ⚠️ CRITICAL: MIGRATION IMMUTABILITY RULE ⚠️

**NEVER edit a migration after running `rails db:migrate` on ANY environment (local, CI, staging, production).**

Once a migration runs, it is **immutable**. Editing deployed migrations causes:
- Schema version mismatches across environments
- Unpredictable behavior when teammates pull changes
- Production deployment failures
- Data corruption risk

### Decision Table: Edit vs New Migration

| Scenario | Action | Command |
|----------|--------|---------|
| Migration not run anywhere | ✅ Edit freely | Edit file directly |
| Migration ran locally only | ⚠️ Rollback, edit, re-run | `rails db:rollback` → edit → `rails db:migrate` |
| Migration ran on CI/staging | ❌ NEVER edit - create NEW fix | `rails g migration FixWhateverIssue` |
| Migration deployed to production | 🚨 ABSOLUTELY NEVER edit | Create compensating migration |

### Fixing Migration Mistakes

```ruby
# ❌ WRONG: Editing db/migrate/20240101_create_users.rb after it ran in staging
# This breaks everyone's database!

# ✅ CORRECT: Create new compensating migration
class FixUsersTableMissingIndex < ActiveRecord::Migration[7.0]
  def change
    add_index :users, :email, unique: true
  end
end
```

### Zero-Downtime Migration Patterns

**Adding NOT NULL columns (3-step deployment):**

```ruby
# Step 1: Add nullable column (deploy code that uses new column)
class AddEmailToUsers < ActiveRecord::Migration[7.0]
  def change
    add_column :users, :email, :string
  end
end

# Step 2: Backfill data (run after deploy, before adding constraint)
class BackfillUserEmails < ActiveRecord::Migration[7.0]
  disable_ddl_transaction!

  def up
    User.in_batches.update_all("email = CONCAT('user_', id, '@example.com')")
  end

  def down
    # No rollback needed for data backfill
  end
end

# Step 3: Add NOT NULL constraint (after 100% data filled)
class AddEmailNotNullConstraint < ActiveRecord::Migration[7.0]
  def change
    change_column_null :users, :email, false
  end
end
```

**Removing columns (2-deploy safety):**

```ruby
# Deploy 1: Ignore column in model (add to ignored_columns)
class User < ApplicationRecord
  self.ignored_columns += [:deprecated_field]
end

# Deploy 2: After above is live, remove the column
class RemoveDeprecatedFieldFromUsers < ActiveRecord::Migration[7.0]
  def change
    safety_assured { remove_column :users, :deprecated_field, :string }
  end
end
```

**Renaming columns (avoid - use alias instead):**

```ruby
# ❌ DANGEROUS: rename_column locks table and breaks running code
def change
  rename_column :users, :name, :full_name
end

# ✅ BETTER: Add new column, dual-write, migrate data, deprecate old
# 1. Add new column
add_column :users, :full_name, :string

# 2. Update code to write to both columns
# 3. Backfill old data
# 4. Deploy code using only new column
# 5. Remove old column (after safe period)
```

### Data Migration Best Practices

```ruby
# Use reversible block for complex data changes
class MigrateUserRoles < ActiveRecord::Migration[7.0]
  def up
    User.where(admin: true).update_all(role: 'admin')
    User.where(admin: false).update_all(role: 'user')
  end

  def down
    User.where(role: 'admin').update_all(admin: true)
    User.where(role: 'user').update_all(admin: false)
  end
end

# For large datasets, use batching to prevent timeouts
class BackfillUserScores < ActiveRecord::Migration[7.0]
  disable_ddl_transaction!

  def up
    User.in_batches(of: 1000).update_all("score = COALESCE(score, 0)")
  end
end
```

### Migration Testing Checklist

Before deploying ANY migration:

- [ ] Test `rails db:migrate` succeeds locally
- [ ] Test `rails db:rollback` works (reversibility)
- [ ] Check migration timing on production-size data in staging
- [ ] Verify no long-running locks (use `CONCURRENTLY` for indexes)
- [ ] Confirm zero-downtime pattern for production changes
- [ ] Review with DBA if touching large tables (>1M rows)

### Index Creation

```ruby
# ❌ WRONG: Default index creation locks table during creation
class AddEmailIndexToUsers < ActiveRecord::Migration[7.0]
  def change
    add_index :users, :email, unique: true
  end
end

# ✅ CORRECT: Concurrent index creation (no lock, safe for production)
class AddEmailIndexToUsers < ActiveRecord::Migration[7.0]
  disable_ddl_transaction!

  def change
    add_index :users, :email, unique: true, algorithm: :concurrently
  end
end
```

### Rails Migration Commands

```bash
rails db:migrate              # Run pending migrations
rails db:rollback             # Rollback last migration
rails db:rollback STEP=3      # Rollback last 3 migrations
rails db:migrate:status       # Show migration status
rails db:migrate VERSION=20240101120000  # Migrate to specific version
```

### Cross-Reference

For PostgreSQL-specific DDL safety patterns (concurrent indexes, column type changes, constraint validation), see the `postgres-database` skill.

## Rails Commands

```bash
bundle exec rspec           # Run tests
bundle exec rubocop -A      # Lint and auto-fix
bundle exec brakeman        # Security scan
rails db:migrate            # Run migrations
rails console               # Interactive console
```

## Completion Report Format

When reporting to PM, include EXACT output:
```
QUALITY GATES PASSED:
- rspec: X/X passing (0 failures)
- coverage: X% (≥85% ✓)
- rubocop: 0 offenses
- brakeman: 0 warnings
- bundle-audit: 0 vulnerabilities
```

❌ NEVER: "tests should pass" or "rubocop looks clean"
✅ ALWAYS: exact counts from terminal output

## File Hygiene

- Docs → `docs/`, Tests → `spec/`, no throwaway files in project root
- Litmus test: "Will this file be useful 200 PRs from now?"
- FORBIDDEN: debug_*.rb, temp scripts, root-level markdown summaries
