# Redis Runbook

## Redis failover steps

1. Confirm the primary is unreachable with `redis-cli -h <primary> PING`.
2. Check replica lag with `INFO replication` on each replica; pick the one with the lowest offset.
3. Promote the chosen replica: `REPLICAOF NO ONE`.
4. Point application config at the new primary and roll the workers.
5. Re-attach the old primary as a replica once it is healthy again.

## After the failover

- Record the time of the failover and the chosen replica in the incident log.
- Verify queue depth returns to normal within 15 minutes.
