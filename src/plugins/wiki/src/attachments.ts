/**
 * Persistent data-access layer for wiki page attachments (feature #97 —
 * "Attachments/file upload support for wiki pages"), step 1.
 *
 * Mirrors `pages.ts`'s own shape and conventions: every method issues its
 * own query through `dbQuery.query(fn)` (never a raw SQL string), reuses
 * `pages.ts`'s locally-declared `WikiDbQueryCapability` (same rationale —
 * this module must not import `database-mysql`'s internals directly, see
 * that file's doc comment), and trusts a caller-supplied `pageId` without
 * re-validating it exists (the same "one writer, structurally separate
 * reader" trust `revisions.ts` places in its own caller — here,
 * `./authorized-attachments.ts`, which always looks the owning page up
 * *before* calling into this module).
 *
 * The one thing this module adds beyond a plain CRUD layer: every write
 * goes through `./attachment-storage.ts`'s filesystem blob storage too, not
 * just the database. `createAttachment` validates the upload
 * (content-type/size, `assertAttachmentUploadAllowed`) and writes the blob
 * to disk *before* inserting the metadata row — and rolls the just-written
 * blob back off disk if the insert itself then fails — so a
 * `wiki_attachments` row and its backing file always exist or don't exist
 * together, never one without the other.
 */
import { NotFoundError } from "../../../core/errors.js";
import {
  assertAttachmentUploadAllowed,
  deleteAttachmentFile,
  generateStorageName,
  readAttachmentFile,
  writeAttachmentFile,
} from "./attachment-storage.js";
import type { WikiDbQueryCapability } from "./pages.js";
import type { Attachment } from "./types.js";

/** Table name — the `wiki_` namespace this plugin's migrations create (feature #22's per-plugin convention). */
export const ATTACHMENTS_TABLE = "wiki_attachments";

/** Raw `wiki_attachments` row shape, before mapping to {@link Attachment}. */
interface AttachmentRow {
  id: number;
  page_id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  storage_name: string;
  uploaded_by: string | null;
  created_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function attachmentFromRow(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    pageId: row.page_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    storageName: row.storage_name,
    uploadedBy: row.uploaded_by,
    createdAt: toDate(row.created_at),
  };
}

/** Input to {@link WikiAttachmentsStore.createAttachment}. */
export interface CreateAttachmentInput {
  readonly pageId: number;
  readonly filename: string;
  readonly contentType: string;
  readonly data: Buffer;
  readonly uploadedBy?: string;
}

/** Where/how big an attachment's blob may be (`./attachment-storage-config.ts`). */
export interface AttachmentStorageOptions {
  readonly dir: string;
  readonly maxBytes: number;
}

/** The typed CRUD surface {@link createWikiAttachmentsStore} returns. */
export interface WikiAttachmentsStore {
  /**
   * Validate (`assertAttachmentUploadAllowed`), then persist a new
   * attachment: writes `input.data` to disk under a fresh
   * `generateStorageName()` value, then inserts the corresponding
   * `wiki_attachments` metadata row. Throws {@link ValidationError} (feature
   * #97 step 1's "size-limited, content-type-validated") if the content
   * type isn't allowlisted or `input.data`'s size is zero or exceeds the
   * configured `maxBytes` — before any bytes are written to disk. If the
   * database insert itself then fails, the just-written blob is deleted
   * again, so a failed create never leaves an orphaned file with no owning
   * row.
   */
  createAttachment(input: CreateAttachmentInput): Promise<Attachment>;
  /** Look up an attachment by its surrogate id. Returns `undefined` if no such attachment exists — never throws. */
  getAttachment(id: number): Promise<Attachment | undefined>;
  /** List every attachment for `pageId`, most-recently-uploaded first. */
  listAttachments(pageId: number): Promise<Attachment[]>;
  /** Read `attachment`'s blob back from disk (feature #97 step 2 — serving an attachment). */
  readAttachmentData(attachment: Attachment): Promise<Buffer>;
}

/**
 * Build the wiki-attachments data-access layer over an already-obtained
 * `db:query` capability handle plus the filesystem storage location/limits
 * to persist blobs under.
 */
export function createWikiAttachmentsStore(
  dbQuery: WikiDbQueryCapability,
  storage: AttachmentStorageOptions,
): WikiAttachmentsStore {
  async function getAttachment(id: number): Promise<Attachment | undefined> {
    const row = await dbQuery.query((db) =>
      db.selectFrom(ATTACHMENTS_TABLE).selectAll().where("id", "=", id).executeTakeFirst(),
    );
    return row === undefined ? undefined : attachmentFromRow(row as unknown as AttachmentRow);
  }

  return {
    async createAttachment(input) {
      assertAttachmentUploadAllowed(
        { contentType: input.contentType, sizeBytes: input.data.byteLength },
        { maxBytes: storage.maxBytes },
      );

      const storageName = generateStorageName();
      // Write to disk first — if this throws, no metadata row is ever
      // created for a file that doesn't actually exist.
      await writeAttachmentFile(storage.dir, storageName, input.data);

      let insertResult;
      try {
        insertResult = await dbQuery.query((db) =>
          db
            .insertInto(ATTACHMENTS_TABLE)
            .values({
              page_id: input.pageId,
              filename: input.filename,
              content_type: input.contentType,
              size_bytes: input.data.byteLength,
              storage_name: storageName,
              uploaded_by: input.uploadedBy ?? null,
            })
            .executeTakeFirstOrThrow(),
        );
      } catch (error) {
        // Roll the just-written blob back off disk — an insert failure
        // must never leave an orphaned file with no owning row. Defense in
        // depth: a genuine driver failure here is rare, but not impossible.
        await deleteAttachmentFile(storage.dir, storageName).catch(() => undefined);
        throw error;
      }

      const id = Number(insertResult.insertId);
      const created = await getAttachment(id);
      if (!created) {
        // Unreachable in practice — the row was just inserted successfully
        // above — but keeps this function's return type honest rather than
        // asserting past a theoretically-possible `undefined`.
        throw new NotFoundError(`Attachment with id ${id} could not be read back after creation.`, {
          details: { id },
        });
      }
      return created;
    },

    getAttachment,

    async listAttachments(pageId) {
      const rows = await dbQuery.query((db) =>
        db
          .selectFrom(ATTACHMENTS_TABLE)
          .selectAll()
          .where("page_id", "=", pageId)
          .orderBy("id", "desc")
          .execute(),
      );
      return (rows as unknown as AttachmentRow[]).map(attachmentFromRow);
    },

    async readAttachmentData(attachment) {
      return readAttachmentFile(storage.dir, attachment.storageName);
    },
  };
}
