import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Several *.integration.test.ts suites (database-mysql's migration
    // runner, rbac's persistence/seed suites — feature #41) drive real,
    // checksum/idempotency-tracked DDL and DML against the one dockerized
    // MySQL instance every suite shares, through global bookkeeping tables
    // (schema_migrations, schema_seeds) and, for rbac specifically, the
    // same literal rbac_* table names across more than one suite. Those
    // suites' own doc comments already call out this as a known race
    // between concurrently-scheduled *files* (not a bug in any one
    // suite's own logic) — running test files sequentially removes the
    // chance of two such suites' setup/teardown interleaving on the same
    // real tables, at the cost of a longer overall run.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
