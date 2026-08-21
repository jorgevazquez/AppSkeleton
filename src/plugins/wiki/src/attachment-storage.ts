/**
 * Filesystem-backed blob storage for wiki page attachments (feature #97 —
 * "Attachments/file upload support for wiki pages"), step 1.
 *
 * ## Stored outside the webroot, with randomized storage names
 *
 * This codebase has no static-file-serving route anywhere — no
 * `@fastify/static`, `sendFile`, or bare directory listing exists in any
 * plugin (confirmed by grepping every plugin's `index.ts`/`src/*.ts`);
 * every response this server ever sends is produced by a route handler
 * registered through `api-gateway`'s `http:route` capability (feature
 * #59). `WIKI_ATTACHMENTS_DIR` (`./attachment-storage-config.ts`) defaults
 * to `<cwd>/var/wiki-attachments` — a plain data directory, not a `public/`
 * or build-output path — but even independent of that default, storing
 * blobs under a directory no route is ever pointed at keeps them
 * structurally unreachable except through `./attachments.ts`'s
 * `readAttachmentData` -> the authorization-checked `GET
 * /wiki/pages/:id/attachments/:attachmentId` route (`../index.ts`, step 2).
 *
 * Every file on disk is named after a cryptographically random
 * {@link generateStorageName} value, never the caller-supplied original
 * filename: the on-disk name carries no caller-controlled data at all — no
 * path traversal, no collision with another attachment's name, and no
 * information leak about what the file actually is, since content-type and
 * the human-readable filename live only in the `wiki_attachments` row
 * (`./attachments.ts`), never in the blob's own path. Every disk read/write
 * below re-validates the storage name against {@link STORAGE_NAME_PATTERN}
 * before joining it onto `dir` — defense in depth against a corrupted or
 * tampered `storage_name` column value ever being used to escape `dir`
 * (no `/`, `\`, or `..` is a valid hex digit, so the pattern alone rules
 * out traversal).
 *
 * ## Content-type / size validation (step 1)
 *
 * {@link assertAttachmentUploadAllowed} is the single gate every upload
 * passes through (`./attachments.ts`'s `createAttachment` calls it before
 * ever touching disk or the database): the declared `contentType` must
 * appear in {@link ALLOWED_ATTACHMENT_CONTENT_TYPES}, and `sizeBytes` must
 * be a positive number no greater than the configured `maxBytes`
 * (`./attachment-storage-config.ts`'s `WIKI_ATTACHMENT_MAX_BYTES`). Both
 * checks run *before* any bytes are written to disk, so a rejected upload
 * never leaves a stray file behind.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "../../../core/errors.js";

/**
 * Allowlisted MIME types a wiki attachment may declare (step 1's
 * "content-type-validated"). Deliberately a small, fixed set of common,
 * inert document/image/data types — no executable/script-shaped type
 * (`text/html`, `application/javascript`, `application/x-sh`, ...) is ever
 * included, since an attachment is served back with exactly this
 * declared content-type (`../index.ts`'s download route) and a browser
 * could otherwise be tricked into rendering/executing an "attachment" as
 * active content.
 */
export const ALLOWED_ATTACHMENT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/zip",
  "application/json",
] as const;

export type AllowedAttachmentContentType = (typeof ALLOWED_ATTACHMENT_CONTENT_TYPES)[number];

/** Whether `contentType` is one of {@link ALLOWED_ATTACHMENT_CONTENT_TYPES}. */
export function isAllowedAttachmentContentType(contentType: string): boolean {
  return (ALLOWED_ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/** Number of random bytes {@link generateStorageName} draws — 24 bytes (192 bits) of entropy, the same order of magnitude as `api-gateway/src/csrf.ts`'s own token size. */
const STORAGE_NAME_BYTES = 24;

/** Every {@link generateStorageName} value matches this exactly — see module docs for why this is also re-checked as a path-traversal guard on every disk read/write. */
const STORAGE_NAME_PATTERN = /^[0-9a-f]{48}$/;

/** Generate a fresh, cryptographically random on-disk storage name — never derived from the caller-supplied filename (see module docs). */
export function generateStorageName(): string {
  return randomBytes(STORAGE_NAME_BYTES).toString("hex");
}

function assertValidStorageName(storageName: string): void {
  if (!STORAGE_NAME_PATTERN.test(storageName)) {
    throw new ValidationError(
      `Attachment storage name "${storageName}" is not a valid generated storage name.`,
      { details: { storageName } },
    );
  }
}

/**
 * Validate an upload's declared `contentType`/`sizeBytes` before any bytes
 * are persisted (step 1). Throws {@link ValidationError} — never writes to
 * disk or the database first.
 */
export function assertAttachmentUploadAllowed(
  input: { readonly contentType: string; readonly sizeBytes: number },
  limits: { readonly maxBytes: number },
): void {
  if (!isAllowedAttachmentContentType(input.contentType)) {
    throw new ValidationError(
      `Content type "${input.contentType}" is not allowed for wiki attachments.`,
      { details: { contentType: input.contentType, allowed: ALLOWED_ATTACHMENT_CONTENT_TYPES } },
    );
  }
  if (input.sizeBytes <= 0) {
    throw new ValidationError("An attachment must not be empty.", {
      details: { sizeBytes: input.sizeBytes },
    });
  }
  if (input.sizeBytes > limits.maxBytes) {
    throw new ValidationError(
      `Attachment size ${input.sizeBytes} bytes exceeds the maximum allowed size of ${limits.maxBytes} bytes.`,
      { details: { sizeBytes: input.sizeBytes, maxBytes: limits.maxBytes } },
    );
  }
}

/** Create `dir` (recursively) if it doesn't already exist. */
async function ensureAttachmentsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Persist `data` under `storageName` inside `dir`, creating `dir` first if
 * needed. Uses a restrictive file mode (owner read/write only) — an
 * attachment's bytes are never meant to be readable by anything other than
 * this process.
 */
export async function writeAttachmentFile(
  dir: string,
  storageName: string,
  data: Buffer,
): Promise<void> {
  assertValidStorageName(storageName);
  await ensureAttachmentsDir(dir);
  await writeFile(path.join(dir, storageName), data, { mode: 0o600 });
}

/** Read a previously-written attachment's bytes back from disk. */
export async function readAttachmentFile(dir: string, storageName: string): Promise<Buffer> {
  assertValidStorageName(storageName);
  return readFile(path.join(dir, storageName));
}

/**
 * Delete a previously-written attachment's on-disk file. Tolerates the
 * file already being gone (`ENOENT`) — a no-op, not an error — e.g. when
 * rolling back a failed database insert (`./attachments.ts`'s
 * `createAttachment`).
 */
export async function deleteAttachmentFile(dir: string, storageName: string): Promise<void> {
  assertValidStorageName(storageName);
  try {
    await unlink(path.join(dir, storageName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
