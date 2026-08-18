import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "mysql2/promise";
import { DatabaseError, ConfigError } from "../../../src/core/errors.js";
import type { DbConfig } from "../../../src/plugins/database-mysql/src/config.js";
import {
  connectWithRetry,
  createDbPool,
  createDbPoolFromEnv,
} from "../../../src/plugins/database-mysql/src/pool.js";

/** Find a TCP port nothing is listening on, so a real connection attempt to it is genuinely refused by the OS. */
async function findUnreachablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("Could not determine a free port."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

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

describe("createDbPool — DB_POOL_QUEUE_LIMIT (feature #23 pool exhaustion knob)", () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  });

  /** mysql2's Pool exposes its resolved pool-level options at `pool.pool.config` (not `.connectionConfig`). */
  function poolQueueLimit(p: Pool) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (p as any).pool.config.queueLimit;
  }

  it("leaves mysql2's default (unbounded, 0) queue when DB_POOL_QUEUE_LIMIT is unset", () => {
    pool = createDbPool(BASE_CONFIG);
    expect(BASE_CONFIG.DB_POOL_QUEUE_LIMIT).toBeUndefined();
    expect(poolQueueLimit(pool)).toBe(0);
  });

  it("carries DB_POOL_QUEUE_LIMIT through to the pool's queueLimit when set", () => {
    pool = createDbPool({ ...BASE_CONFIG, DB_POOL_QUEUE_LIMIT: 2 });
    expect(poolQueueLimit(pool)).toBe(2);
  });
});

describe("connectWithRetry — startup connectivity probe with retry/backoff (feature #23)", () => {
  /** A fake mysql2 connection: `ping()`/`release()` are spied so tests can assert on release-on-both-paths. */
  function fakeConnection(pingImpl: () => Promise<void>) {
    return {
      ping: vi.fn(pingImpl),
      release: vi.fn(),
    };
  }

  /** A fake mysql2 Pool whose `getConnection()` behavior is fully controlled by the test. */
  function fakePool(getConnectionImpl: () => Promise<ReturnType<typeof fakeConnection>>): Pool {
    return { getConnection: vi.fn(getConnectionImpl) } as unknown as Pool;
  }

  function connectionRefusedError(): Error & { code: string } {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:3306") as Error & { code: string };
    error.code = "ECONNREFUSED";
    return error;
  }

  it("succeeds immediately (no retry) when the database is reachable on the first attempt", async () => {
    const connection = fakeConnection(async () => undefined);
    const pool = fakePool(async () => connection);
    const sleep = vi.fn(async (_ms: number) => undefined);

    await expect(connectWithRetry(pool, { sleep })).resolves.toBeUndefined();
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(connection.ping).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("simulates a temporarily unreachable database: retries with backoff, then succeeds once it recovers", async () => {
    let attempts = 0;
    const connection = fakeConnection(async () => undefined);
    const pool = fakePool(async () => {
      attempts += 1;
      // "Temporarily unreachable" — the first two attempts are refused
      // (e.g. MySQL still starting up inside its container), the third
      // succeeds once it's actually listening.
      if (attempts <= 2) {
        throw connectionRefusedError();
      }
      return connection;
    });
    const sleep = vi.fn(async (_ms: number) => undefined);

    await connectWithRetry(pool, {
      retries: 5,
      initialDelayMs: 100,
      factor: 2,
      jitter: false,
      sleep,
    });

    expect(pool.getConnection).toHaveBeenCalledTimes(3);
    expect(connection.ping).toHaveBeenCalledTimes(1);
    // Exponential backoff: 100ms before the 2nd attempt, 200ms before the 3rd.
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([100, 200]);
  });

  it("throws a DatabaseError (not the raw driver exception) once retries are exhausted against a still-unreachable database", async () => {
    const refused = connectionRefusedError();
    const pool = fakePool(async () => {
      throw refused;
    });
    const sleep = vi.fn(async (_ms: number) => undefined);

    const promise = connectWithRetry(pool, { retries: 3, sleep });

    await expect(promise).rejects.toBeInstanceOf(DatabaseError);
    await expect(promise).rejects.not.toBe(refused);
    await expect(promise).rejects.toMatchObject({
      cause: refused,
      message: expect.stringContaining("3 attempt") as unknown as string,
    });
    expect(pool.getConnection).toHaveBeenCalledTimes(3);
  });

  it("never leaks the raw driver error's message into the public-facing message", async () => {
    const pool = fakePool(async () => {
      throw connectionRefusedError();
    });

    try {
      await connectWithRetry(pool, { retries: 1, sleep: async () => undefined });
      expect.fail("expected connectWithRetry to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError);
      const dbError = error as DatabaseError;
      expect(dbError.publicMessage).not.toContain("ECONNREFUSED");
      expect(dbError.publicMessage).not.toContain("127.0.0.1");
    }
  });

  it("always releases an acquired connection back to the pool, even when ping() itself fails", async () => {
    const connection = fakeConnection(async () => {
      throw connectionRefusedError();
    });
    const pool = fakePool(async () => connection);

    await expect(
      connectWithRetry(pool, { retries: 1, sleep: async () => undefined }),
    ).rejects.toBeInstanceOf(DatabaseError);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it("retries against a genuinely unreachable TCP port (real mysql2 driver, real ECONNREFUSED) and gives up cleanly", async () => {
    // No fake/mocked driver here: a real mysql2 pool pointed at a port
    // nothing is listening on produces a real, OS-level ECONNREFUSED —
    // exercising the exact same code path a genuinely-down MySQL instance
    // would hit, not just a hand-constructed error shape.
    const unreachablePort = await findUnreachablePort();
    const pool = createDbPool({
      DB_HOST: "127.0.0.1",
      DB_PORT: unreachablePort,
      DB_USER: "appskeleton",
      DB_PASSWORD: "change-me",
      DB_NAME: "appskeleton",
      DB_CONNECTION_LIMIT: 1,
      DB_SSL: "disabled",
      DB_SSL_REJECT_UNAUTHORIZED: true,
    });

    try {
      const attempts: number[] = [];
      const promise = connectWithRetry(pool, {
        retries: 3,
        initialDelayMs: 5,
        maxDelayMs: 20,
        jitter: false,
        onRetry: ({ attempt }) => attempts.push(attempt),
      });

      await expect(promise).rejects.toBeInstanceOf(DatabaseError);
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining("3 attempt") as unknown as string,
      });
      // Two retries were attempted (after attempt 1 and attempt 2) before
      // the 3rd and final attempt also failed and connectWithRetry gave up.
      expect(attempts).toEqual([1, 2]);
    } finally {
      await pool.end();
    }
  });
});
