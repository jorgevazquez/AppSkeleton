/**
 * Shared kernel-wide type utilities. Starts with the Result-style type used
 * throughout the kernel for operations where failure is an expected,
 * recoverable outcome (manifest validation, capability checks, config
 * loading) rather than an exceptional one — callers get a typed error
 * value instead of an unwinding throw, and TypeScript forces the failure
 * branch to be handled at the call site.
 *
 * Pairs with the AppError taxonomy in errors.ts: `Result<T>` defaults its
 * error variant to AppError, but any error type works.
 */
import type { AppError } from "./errors.js";

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = AppError> = Ok<T> | Err<E>;

/** Wrap a successful value as a Result. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Wrap a failure value as a Result. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Narrow a Result to its Ok variant. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Narrow a Result to its Err variant. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Return the Ok value, or throw the Err value. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

/** Return the Ok value, or `fallback` if the result is an Err. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Transform the Ok value of a Result, passing an Err through unchanged. */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Transform the Err value of a Result, passing an Ok through unchanged. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}
