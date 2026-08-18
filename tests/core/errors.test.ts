import { describe, expect, it } from "vitest";
import {
  AppError,
  CapabilityDeniedError,
  ConfigError,
  DatabaseError,
  MigrationError,
  NotFoundError,
  PluginLoadError,
  RateLimitError,
  ValidationError,
  isAppError,
  toErrorEnvelope,
} from "../../src/core/errors.js";

describe("ValidationError", () => {
  it("carries a stable machine-readable code and status", () => {
    const error = new ValidationError("field 'password' failed regex /^.{12,}$/");
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.statusCode).toBe(400);
  });

  it("has a safe default public message that does not leak the internal detail", () => {
    const error = new ValidationError("field 'password' failed regex /^.{12,}$/");
    expect(error.publicMessage).not.toContain("password");
    expect(error.publicMessage).not.toContain("regex");
    expect(error.publicMessage.length).toBeGreaterThan(0);
  });
});

describe("ConfigError", () => {
  it("carries a stable machine-readable code and status", () => {
    const error = new ConfigError("DATABASE_URL env var missing at /etc/secrets/db.env");
    expect(error.code).toBe("CONFIG_ERROR");
    expect(error.statusCode).toBe(500);
  });

  it("has a safe default public message that does not leak the internal detail", () => {
    const error = new ConfigError("DATABASE_URL env var missing at /etc/secrets/db.env");
    expect(error.publicMessage).not.toContain("DATABASE_URL");
    expect(error.publicMessage).not.toContain("/etc/secrets");
    expect(error.message).toContain("DATABASE_URL");
  });
});

describe("PluginLoadError", () => {
  it("carries a stable machine-readable code and status", () => {
    const error = new PluginLoadError("plugin 'wiki' threw during onEnable(): ECONNREFUSED");
    expect(error.code).toBe("PLUGIN_LOAD_ERROR");
    expect(error.statusCode).toBe(500);
  });

  it("has a safe default public message that does not leak the internal detail", () => {
    const error = new PluginLoadError("plugin 'wiki' threw during onEnable(): ECONNREFUSED");
    expect(error.publicMessage).not.toContain("wiki");
    expect(error.publicMessage).not.toContain("ECONNREFUSED");
  });
});

describe("CapabilityDeniedError", () => {
  it("carries a stable machine-readable code and status", () => {
    const error = new CapabilityDeniedError("plugin 'wiki' requested db:query without a grant");
    expect(error.code).toBe("CAPABILITY_DENIED");
    expect(error.statusCode).toBe(403);
  });

  it("has a safe default public message that does not leak the internal detail", () => {
    const error = new CapabilityDeniedError("plugin 'wiki' requested db:query without a grant");
    expect(error.publicMessage).not.toContain("wiki");
    expect(error.publicMessage).not.toContain("db:query");
  });
});

describe("DatabaseError", () => {
  it("carries a stable machine-readable code and status", () => {
    const error = new DatabaseError("ER_DUP_ENTRY: Duplicate entry 'x' for key 'PRIMARY'");
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("DATABASE_ERROR");
    expect(error.statusCode).toBe(500);
  });

  it("has a safe default public message that does not leak driver-level detail", () => {
    const error = new DatabaseError("ER_DUP_ENTRY: Duplicate entry 'x' for key 'PRIMARY'");
    expect(error.publicMessage).not.toContain("ER_DUP_ENTRY");
    expect(error.publicMessage).not.toContain("PRIMARY");
    expect(error.publicMessage.length).toBeGreaterThan(0);
  });
});

describe("MigrationError", () => {
  it("carries a stable machine-readable code and status", () => {
    const error = new MigrationError(
      "migration '0001_create_widgets.ts' checksum mismatch: recorded abc123, computed def456",
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("MIGRATION_ERROR");
    expect(error.statusCode).toBe(500);
  });

  it("has a safe default public message that does not leak migration/checksum detail", () => {
    const error = new MigrationError(
      "migration '0001_create_widgets.ts' checksum mismatch: recorded abc123, computed def456",
    );
    expect(error.publicMessage).not.toContain("0001_create_widgets.ts");
    expect(error.publicMessage).not.toContain("abc123");
    expect(error.publicMessage.length).toBeGreaterThan(0);
  });
});

describe("NotFoundError", () => {
  it("carries a stable machine-readable code and status", () => {
    const error = new NotFoundError("no route matches GET /widgets/999");
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.statusCode).toBe(404);
  });

  it("has a non-empty default public message", () => {
    const error = new NotFoundError("no route matches GET /widgets/999");
    expect(error.publicMessage.length).toBeGreaterThan(0);
  });
});

describe("RateLimitError", () => {
  it("carries a stable machine-readable code and status", () => {
    const error = new RateLimitError(
      "Rate limit exceeded for GET /api/v1/widgets: more than 5 requests, retry after 1 second.",
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(error.statusCode).toBe(429);
  });

  it("has a non-empty default public message", () => {
    const error = new RateLimitError("Rate limit exceeded for GET /api/v1/widgets");
    expect(error.publicMessage.length).toBeGreaterThan(0);
  });
});

describe("AppError construction options", () => {
  it("accepts an explicit safe public message override", () => {
    const error = new ValidationError("field 'password' failed regex /^.{12,}$/", {
      publicMessage: "The 'password' field does not meet the strength requirements.",
    });
    expect(error.publicMessage).toBe(
      "The 'password' field does not meet the strength requirements.",
    );
  });

  it("keeps the internal message and public message independent", () => {
    const error = new ConfigError("DATABASE_URL env var missing", {
      publicMessage: "The server is misconfigured.",
    });
    expect(error.message).toBe("DATABASE_URL env var missing");
    expect(error.publicMessage).toBe("The server is misconfigured.");
  });

  it("attaches structured, safe details for API consumers", () => {
    const error = new ValidationError("bad input", { details: { field: "email" } });
    expect(error.details).toEqual({ field: "email" });
  });

  it("supports an internal-only cause that is never part of the public surface", () => {
    const cause = new Error("ECONNREFUSED 127.0.0.1:3306");
    const error = new PluginLoadError("failed to load plugin 'database-mysql'", { cause });
    expect(error.cause).toBe(cause);
    expect(JSON.stringify(error.toJSON())).not.toContain("ECONNREFUSED");
  });
});

describe("isAppError", () => {
  it("returns true for AppError subclasses", () => {
    expect(isAppError(new ValidationError("bad input"))).toBe(true);
  });

  it("returns false for plain errors and non-errors", () => {
    expect(isAppError(new Error("boom"))).toBe(false);
    expect(isAppError("boom")).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });
});

describe("AppError#toJSON serialization", () => {
  it("serializes to an API error envelope shape without a stack trace by default", () => {
    const error = new CapabilityDeniedError("plugin 'wiki' lacks capability db:query", {
      publicMessage: "You do not have permission to perform this action.",
      details: { capability: "db:query" },
    });

    const json = error.toJSON();

    expect(json).toEqual({
      code: "CAPABILITY_DENIED",
      message: "You do not have permission to perform this action.",
      details: { capability: "db:query" },
    });
    expect(json).not.toHaveProperty("stack");
  });

  it("omits `details` entirely when none were provided (no leaking empty internals)", () => {
    const error = new ValidationError("bad input");
    const json = error.toJSON();
    expect(json).not.toHaveProperty("details");
  });

  it("round-trips cleanly through JSON.stringify/parse with no stack trace", () => {
    const error = new ValidationError("bad input");
    const serialized = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    expect(serialized["code"]).toBe("VALIDATION_ERROR");
    expect(serialized).not.toHaveProperty("stack");
    expect(serialized).not.toHaveProperty("cause");
  });

  it("can opt into including the stack trace for internal/dev diagnostics only", () => {
    const error = new ConfigError("missing env var FOO");
    const withoutStack = error.toJSON();
    const withStack = error.toJSON({ includeStack: true });
    expect(withoutStack).not.toHaveProperty("stack");
    expect(typeof withStack.stack).toBe("string");
    expect(withStack.stack).toContain("ConfigError");
  });
});

describe("toErrorEnvelope", () => {
  it("delegates to AppError#toJSON for AppError instances", () => {
    const error = new ValidationError("bad input", { publicMessage: "Bad input." });
    expect(toErrorEnvelope(error)).toEqual({
      code: "VALIDATION_ERROR",
      message: "Bad input.",
    });
  });

  it("collapses unknown thrown values to a generic, non-leaking envelope", () => {
    const envelope = toErrorEnvelope(new Error("secret internal stack detail"));
    expect(envelope).toEqual({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    });
    expect(JSON.stringify(envelope)).not.toContain("secret internal stack detail");
  });

  it("collapses non-Error thrown values (e.g. a thrown string) safely", () => {
    expect(toErrorEnvelope("raw string throw")).toEqual({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    });
  });

  it("never includes a stack trace unless explicitly requested", () => {
    const plain = new Error("boom");
    expect(toErrorEnvelope(plain)).not.toHaveProperty("stack");
    expect(toErrorEnvelope(plain, { includeStack: true })).toHaveProperty("stack");
  });
});
