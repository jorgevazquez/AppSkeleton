import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import {
  err,
  isErr,
  isOk,
  mapErr,
  mapResult,
  ok,
  unwrap,
  unwrapOr,
  type Result,
} from "../../src/core/types.js";

describe("ok / err / isOk / isErr", () => {
  it("ok() creates a successful result narrowed by isOk()", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    if (isOk(result)) {
      expect(result.value).toBe(42);
    }
  });

  it("err() creates a failed result narrowed by isErr(), carrying an AppError", () => {
    const error = new ValidationError("bad input");
    const result = err(error);
    expect(result.ok).toBe(false);
    expect(isErr(result)).toBe(true);
    expect(isOk(result)).toBe(false);
    if (isErr(result)) {
      expect(result.error).toBe(error);
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("unwrap", () => {
  it("returns the value for an Ok result", () => {
    expect(unwrap(ok("value"))).toBe("value");
  });

  it("throws the error for an Err result", () => {
    const error = new ValidationError("bad input");
    expect(() => unwrap(err(error))).toThrow(error);
  });
});

describe("unwrapOr", () => {
  it("returns the value for an Ok result", () => {
    expect(unwrapOr(ok("value"), "fallback")).toBe("value");
  });

  it("returns the fallback for an Err result", () => {
    expect(unwrapOr(err(new ValidationError("bad input")), "fallback")).toBe("fallback");
  });
});

describe("mapResult", () => {
  it("transforms the Ok value", () => {
    const mapped = mapResult(ok(2), (n) => n * 2);
    expect(unwrap(mapped)).toBe(4);
  });

  it("passes an Err through unchanged", () => {
    const error = new ValidationError("bad input");
    const input: Result<number, ValidationError> = err(error);
    const mapped = mapResult(input, (n: number) => n * 2);
    expect(isErr(mapped)).toBe(true);
    if (isErr(mapped)) {
      expect(mapped.error).toBe(error);
    }
  });
});

describe("mapErr", () => {
  it("transforms the Err value", () => {
    const mapped = mapErr(err(new ValidationError("bad input")), (e) => e.code);
    expect(isErr(mapped)).toBe(true);
    if (isErr(mapped)) {
      expect(mapped.error).toBe("VALIDATION_ERROR");
    }
  });

  it("passes an Ok through unchanged", () => {
    const input: Result<number, ValidationError> = ok(5);
    const mapped = mapErr(input, (e: ValidationError) => e.code);
    expect(unwrap(mapped)).toBe(5);
  });
});
