import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { ConfigError } from "../../../src/core/errors.js";
import type { DbConfig } from "../../../src/plugins/database-mysql/src/config.js";
import { createDbPool, createDbPoolFromEnv } from "../../../src/plugins/database-mysql/src/pool.js";

const VALID_ENV = {
  DB_HOST: "127.0.0.1",
  DB_PORT: "3306",
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
  DB_CONNECTION_LIMIT: "5",
};

const BASE_CONFIG: DbConfig = {
  DB_HOST: "127.0.0.1",
  DB_PORT: 3306,
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
  DB_CONNECTION_LIMIT: 7,
  DB_SSL: "disabled",
  DB_SSL_REJECT_UNAUTHORIZED: true,
};

/** mysql2's Pool exposes its resolved connection options at `pool.pool.config`. */
function poolConnectionConfig(pool: Pool) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching into mysql2's internal (but public/typed) Pool shape for introspection-only assertions.
  return (pool as any).pool.config.connectionConfig;
}
function poolConnectionLimit(pool: Pool) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (pool as any).pool.config.connectionLimit;
}

describe("createDbPool — pure construction from a validated config", () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  });

  it("constructs a mysql2 promise pool without connecting eagerly", () => {
    pool = createDbPool(BASE_CONFIG);
    expect(pool).toBeDefined();
    expect(typeof pool.query).toBe("function");
    expect(typeof pool.getConnection).toBe("function");
  });

  it("carries host/port/user/password/database through to the pool's connection config", () => {
    pool = createDbPool(BASE_CONFIG);
    const cfg = poolConnectionConfig(pool);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(3306);
    expect(cfg.user).toBe("appskeleton");
    expect(cfg.password).toBe("change-me");
    expect(cfg.database).toBe("appskeleton");
  });

  it("carries DB_CONNECTION_LIMIT through to the pool's connectionLimit", () => {
    pool = createDbPool(BASE_CONFIG);
    expect(poolConnectionLimit(pool)).toBe(7);
  });

  it("does not set ssl on the connection config when DB_SSL is disabled", () => {
    pool = createDbPool(BASE_CONFIG);
    const cfg = poolConnectionConfig(pool);
    expect(cfg.ssl).toBeFalsy();
  });

  it("sets ssl options on the connection config when DB_SSL is enabled", () => {
    pool = createDbPool({ ...BASE_CONFIG, DB_SSL: "enabled", DB_SSL_REJECT_UNAUTHORIZED: false });
    const cfg = poolConnectionConfig(pool);
    expect(cfg.ssl).toBeTruthy();
    expect(cfg.ssl.rejectUnauthorized).toBe(false);
  });

  it("passes DB_SSL_CA through into the ssl options when supplied", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----";
    pool = createDbPool({ ...BASE_CONFIG, DB_SSL: "enabled", DB_SSL_CA: ca });
    const cfg = poolConnectionConfig(pool);
    expect(cfg.ssl.ca).toBe(ca);
  });
});

describe("createDbPoolFromEnv — fail-fast startup wiring", () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  });

  it("throws a ConfigError (not a mysql2 error) when required DB_* config is missing", () => {
    expect(() => createDbPoolFromEnv({ env: {} })).toThrow(ConfigError);
  });

  it("throws before ever constructing a pool when config is malformed", () => {
    expect(() => createDbPoolFromEnv({ env: { ...VALID_ENV, DB_PORT: "not-a-port" } })).toThrow(
      ConfigError,
    );
  });

  it("constructs a working pool from valid env", () => {
    pool = createDbPoolFromEnv({ env: VALID_ENV });
    expect(pool).toBeDefined();
    expect(poolConnectionLimit(pool)).toBe(5);
  });
});
