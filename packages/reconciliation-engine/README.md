# Reconciliation engine

Pure, deterministic comparison and recovery planning. PostgreSQL rows
are always treated as official authority; ClickHouse rows are rebuildable
projections. The package does not mutate either datastore and never performs an
in-place ClickHouse rebuild.
