# AWS Aurora PostgreSQL

## Aurora Cluster Architecture

- Multi-AZ cluster design with automatic failover
- Read replica management and automatic promotion
- Cluster endpoints vs reader endpoints
- Instance types: balanced, compute, memory optimized

## Aurora Serverless v2

```
Auto-scaling: ACU (Aurora Capacity Units)
Cost: Pay-per-second vs reserved instances
Use case: Variable workloads
```

- Warm pool for quick scaling
- Monitor scaling events and performance impact

## Aurora Global Database

```
RPO: < 1 second typical
RTO: < 1 minute typical
```

- Multi-region disaster recovery
- Read-only secondaries for geographic distribution
- Cross-region backup and restore

## Fast Cloning

- Zero-copy cloning (copy-on-write)
- Use cases: test migrations, feature branches, debugging
- Storage cost: incremental only

## Aurora-Specific Optimizations

- **Fast DDL**: Schema changes without lock
- **Parallel Query**: Distributed query across cluster
- **Aurora Storage**: Fault-tolerant distributed layer
- **Aurora Cache**: Intelligent query caching

## CloudWatch Metrics

| Metric | Target |
|---|---|
| CPU utilization | 20-80% |
| Read/write latency | < 1-5ms |
| Replication lag | < 100ms |

## Performance Insights

- Database Load metric
- Wait events analysis
- Slow query identification
- 7+ day retention for trends

## IAM Database Authentication

```bash
# Token-based auth (no passwords)
aws rds generate-db-auth-token \
  --hostname cluster.region.rds.amazonaws.com \
  --port 5432 \
  --username myuser
```

- 15-minute token expiration
- Secrets Manager integration

## AWS Commands

```bash
# Describe cluster
aws rds describe-db-clusters --db-cluster-identifier aurora-cluster

# Create snapshot
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier aurora-cluster \
  --db-cluster-snapshot-identifier snapshot-name

# Restore from snapshot
aws rds restore-db-cluster-from-snapshot \
  --db-cluster-identifier restored-cluster \
  --snapshot-identifier snapshot-name
```
