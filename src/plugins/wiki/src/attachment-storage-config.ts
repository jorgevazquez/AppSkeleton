/**
 * Zod-validated configuration for the wiki plugin's attachment storage
 * (feature #97 — "Attachments/file upload support for wiki pages"), step 1.
 * Reuses the kernel's generic layered engine (`core/config.ts`'s
 * `loadConfig()`: defaults -> env -> optional operator override file), the
 * same pattern `api-gateway/src/request-limits-config.ts`/
 * `rate-limit-config.ts` already establish for this codebase — see those
 * modules' docs for the full precedence explanation.
 *
 * Fields:
 *   - `WIKI_ATTACHMENTS_DIR` — the directory attachment blobs are written
 *     under (`../attachment-storage.ts`'s `writeAttachmentFile`/
 *     `readAttachmentFile`). Defaults to `<cwd>/var/wiki-attachments` — a
 *     plain data directory outside any served/static path. This codebase
 *     has no static-file-serving route at all (no `@fastify/static`,
 *     `sendFile`, or bare directory listing anywhere — confirmed by
 *     grepping every plugin's `index.ts`/`src/*.ts`), so every byte of an
 *     attachment can only ever reach a client through
 *     `../index.ts`'s authorization-checked `GET
 *     /wiki/pages/:id/attachments/:attachmentId` route (feature #97, step
 *     2) — never by requesting a path under this directory directly. An
 *     operator may point this at any absolute path outside the
 *     deployment's own source/build tree (e.g. a mounted volume in
 *     production).
 *   - `WIKI_ATTACHMENT_MAX_BYTES` — this plugin's own per-attachment size
 *     limit (step 1's "size-limited"), enforced by
 *     `../attachment-storage.ts`'s `assertAttachmentUploadAllowed` before
 *     any bytes are written to disk or a database row inserted. Defaults
 *     to 5 MiB. Independent of (and by default smaller than) api-gateway's
 *     own global `REQUEST_BODY_LIMIT_BYTES`
 *     (`api-gateway/src/request-limits-config.ts`, default 1 MiB) — an
 *     upload is submitted as a base64-encoded JSON field (`../index.ts`'s
 *     `POST .../attachments` route body schema), which inflates roughly
 *     4/3 over the raw byte count. A deployment raising this value above
 *     what the global request body limit (inflated by 4/3) can hold must
 *     also raise `REQUEST_BODY_LIMIT_BYTES` to match, or the JSON body
 *     itself will be rejected by Fastify's own `bodyLimit` (a generic 413)
 *     before this plugin's own validation — and its friendlier
 *     {@link ValidationError} — ever runs.
 *
 * Both are safe to load unconditionally at boot (like
 * `RequestLimitsConfigSchema`, unlike `SessionConfigSchema`'s required
 * `SESSION_SECRET`) — a deployment with neither var set still boots with
 * sane, documented defaults.
 */
import path from "node:path";
import { z } from "zod";
import { loadConfig, type LoadConfigOptions } from "../../../core/config.js";

export const AttachmentStorageConfigSchema = z.object({
  WIKI_ATTACHMENTS_DIR: z
    .string()
    .min(1, "must not be empty")
    .default(path.join(process.cwd(), "var", "wiki-attachments")),
  WIKI_ATTACHMENT_MAX_BYTES: z.coerce
    .number()
    .int("must be an integer")
    .positive("must be a positive number of bytes")
    .default(5 * 1024 * 1024),
});

export type AttachmentStorageConfig = z.infer<typeof AttachmentStorageConfigSchema>;

/**
 * Load and validate the wiki plugin's attachment storage config. Throws a
 * {@link ConfigError} (via `loadConfig()`) with a human-readable message
 * naming the offending field(s) when `WIKI_ATTACHMENTS_DIR`/
 * `WIKI_ATTACHMENT_MAX_BYTES` are set but malformed (empty path,
 * non-numeric, zero, or negative byte limit).
 */
export function loadAttachmentStorageConfig(
  options: Omit<LoadConfigOptions<typeof AttachmentStorageConfigSchema.shape>, "schema"> = {},
): AttachmentStorageConfig {
  return loadConfig({ schema: AttachmentStorageConfigSchema, ...options });
}
