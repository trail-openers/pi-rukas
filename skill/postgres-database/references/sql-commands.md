# PostgreSQL SQL Commands Reference

## Performance Analysis

```sql
-- Query plan with timing and buffers
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM orders WHERE user_id = 123;

-- Top slow queries (requires pg_stat_statements)
SELECT * FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;

-- Unused indexes
SELECT * FROM pg_stat_user_indexes
WHERE idx_scan = 0;

-- Active connections
SELECT * FROM pg_stat_activity
WHERE state != 'idle';

-- Connection count by database
SELECT datname, usename, application_name, state
FROM pg_stat_activity;
```

## Index Management

```sql
-- Create index without locking
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);

-- Reindex without locking
REINDEX CONCURRENTLY INDEX idx_users_email;

-- Drop index safely
DROP INDEX CONCURRENTLY idx_users_email;

-- Partial index (only active records)
CREATE INDEX idx_active_users ON users(email)
WHERE active = true;

-- Covering index (index-only scans)
CREATE INDEX idx_orders_user ON orders(user_id)
INCLUDE (total, created_at);

-- GIN index for JSONB
CREATE INDEX idx_users_metadata ON users
USING GIN(metadata jsonb_path_ops);
```

## Table Maintenance

```sql
-- Vacuum with stats
VACUUM (VERBOSE, ANALYZE) table_name;

-- Analyze table
ANALYZE table_name;

-- Table size
SELECT pg_size_pretty(pg_total_relation_size('table_name'));

-- Index bloat detection
SELECT schemaname, tablename,
  round(bloat_ratio*100) as bloat_pct
FROM pgstattuple_approx('table_name');
```

## Lock Monitoring

```sql
-- View current locks
SELECT * FROM pg_locks;

-- Blocking queries
SELECT blocked_locks.pid AS blocked_pid,
  blocked_activity.usename AS blocked_user,
  blocking_locks.pid AS blocking_pid,
  blocking_activity.usename AS blocking_user,
  blocked_activity.query AS blocked_statement,
  blocking_activity.query AS blocking_statement
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity
  ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
  AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
  AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
  AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
  AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
  AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
  AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
  AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity
  ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

## Migration Safety Checklist

- [ ] Check for table locks (`SELECT * FROM pg_locks`)
- [ ] Estimate time on staging with production data size
- [ ] Verify rollback capability with dry-run
- [ ] Test on staging with current production data
- [ ] Plan deployment window (low-traffic)
- [ ] Monitor during deployment
- [ ] Have rollback plan documented
- [ ] Validate data integrity after migration
