/**
 * RBAC-guarded facade over {@link WikiAttachmentsStore} (feature #97 —
 * "Attachments/file upload support for wiki pages"), step 2 — mirrors
 * `authorized-store.ts`'s own shape and conventions exactly (see that
 * module's doc comment for the full rationale this one reuses):
 *
 *   - Every method takes a leading `userId` (the resolved caller identity)
 *     and throws via `./access.ts`'s {@link assertWikiAccessAudited} before
 *     ever touching the underlying `pages`/`attachments` stores.
 *   - An attachment has no namespace of its own — it belongs to a page,
 *     which belongs to a namespace — so every method here looks the owning
 *     page up first (a read with no side effects), then authorizes using
 *     *that page's* `namespaceId` (or no namespace context at all, falling
 *     back to the global default, if `pageId` doesn't match a page). Only
 *     once authorization has not thrown does a missing page surface as
 *     {@link NotFoundError} — an unauthorized caller gets the same 401/403
 *     whether or not the page (or the attachment) they asked about
 *     actually exists, exactly like `authorized-store.ts`'s own
 *     `getPageById`/`updatePage`/`deletePage`.
 *   - Action mapping: uploading is a `write` (it changes what's attached to
 *     a page, the same class of operation as `createPage`/`updatePage`);
 *     listing and downloading are both `read` — an attachment is exactly
 *     as sensitive as the page content it's attached to, so anyone who can
 *     read the page can read what's attached to it, and nothing more.
 *
 * `getAttachmentWithData` is this feature's step 2 ("serve attachments
 * through an authorization-checked route ... respecting the page's
 * permissions, never directly from a static directory"): the download
 * route (`../index.ts`) calls this and *only* this to obtain an
 * attachment's bytes — there is no other path to the blob's contents that
 * skips the page's own `read` check.
 */
import type { AuditSink } from "../../../core/audit.js";
import { NotFoundError } from "../../../core/errors.js";
import type { RbacCheckCapability } from "../../rbac/index.js";
import { assertWikiAccessAudited, recordWikiAudit, wikiAuditTarget } from "./access.js";
import type { CreateAttachmentInput, WikiAttachmentsStore } from "./attachments.js";
import type { WikiPagesStore } from "./pages.js";
import type { Attachment } from "./types.js";

/** Fields a caller supplies to {@link AuthorizedAttachmentsStore.uploadAttachment} — everything `CreateAttachmentInput` needs except `pageId`/`uploadedBy`, which this module resolves itself (the authorized page, and the caller's own identity). */
export type UploadAttachmentInput = Omit<CreateAttachmentInput, "pageId" | "uploadedBy">;

/** The RBAC-guarded surface {@link createAuthorizedAttachmentsStore} returns. */
export interface AuthorizedAttachmentsStore {
  /** Requires `write` on the page's namespace. Throws {@link NotFoundError} if `pageId` doesn't reference an existing page. See `WikiAttachmentsStore.createAttachment` for the underlying validation/persistence behavior. */
  uploadAttachment(
    userId: string | undefined,
    pageId: number,
    input: UploadAttachmentInput,
  ): Promise<Attachment>;
  /** Requires `read` on the page's namespace. Throws {@link NotFoundError} if `pageId` doesn't reference an existing page. */
  listAttachments(userId: string | undefined, pageId: number): Promise<Attachment[]>;
  /** Requires `read` on the page's namespace. Throws {@link NotFoundError} if `pageId` doesn't reference an existing page, or if `attachmentId` doesn't reference an attachment belonging to it. */
  getAttachmentWithData(
    userId: string | undefined,
    pageId: number,
    attachmentId: number,
  ): Promise<{ attachment: Attachment; data: Buffer }>;
}

/**
 * Build the RBAC-guarded facade over already-constructed `pages`/
 * `attachments` stores (`./pages.js`'s {@link WikiPagesStore}, `./attachments.js`'s
 * {@link WikiAttachmentsStore}) and an already-obtained `rbac:check`
 * capability handle — mirrors `authorized-store.ts`'s
 * `createAuthorizedWikiStore`'s own "accept an already-obtained dependency,
 * build nothing yourself" shape.
 */
export function createAuthorizedAttachmentsStore(
  pages: WikiPagesStore,
  attachments: WikiAttachmentsStore,
  rbacCheck: RbacCheckCapability,
  auditSink?: AuditSink,
): AuthorizedAttachmentsStore {
  return {
    async uploadAttachment(userId, pageId, input) {
      const page = await pages.getPageById(pageId);
      assertWikiAccessAudited(
        auditSink,
        rbacCheck,
        userId,
        "write",
        wikiAuditTarget(pageId, page?.namespaceId),
        page?.namespaceId,
      );
      if (!page) {
        throw new NotFoundError(`Page with id ${pageId} does not exist.`, { details: { pageId } });
      }

      const attachment = await attachments.createAttachment({
        pageId: page.id,
        filename: input.filename,
        contentType: input.contentType,
        data: input.data,
        uploadedBy: userId,
      });
      recordWikiAudit(auditSink, {
        actor: userId as string,
        action: "wiki:attachment-upload",
        target: wikiAuditTarget(page.id, page.namespaceId, page.slug),
        outcome: "created",
        details: {
          attachmentId: attachment.id,
          filename: attachment.filename,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
        },
      });
      return attachment;
    },

    async listAttachments(userId, pageId) {
      const page = await pages.getPageById(pageId);
      assertWikiAccessAudited(
        auditSink,
        rbacCheck,
        userId,
        "read",
        wikiAuditTarget(pageId, page?.namespaceId),
        page?.namespaceId,
      );
      if (!page) {
        throw new NotFoundError(`Page with id ${pageId} does not exist.`, { details: { pageId } });
      }
      return attachments.listAttachments(page.id);
    },

    async getAttachmentWithData(userId, pageId, attachmentId) {
      const page = await pages.getPageById(pageId);
      assertWikiAccessAudited(
        auditSink,
        rbacCheck,
        userId,
        "read",
        wikiAuditTarget(pageId, page?.namespaceId),
        page?.namespaceId,
      );
      if (!page) {
        throw new NotFoundError(`Page with id ${pageId} does not exist.`, { details: { pageId } });
      }

      const attachment = await attachments.getAttachment(attachmentId);
      if (!attachment || attachment.pageId !== page.id) {
        throw new NotFoundError(`Attachment ${attachmentId} does not exist on page ${pageId}.`, {
          details: { pageId, attachmentId },
        });
      }

      const data = await attachments.readAttachmentData(attachment);
      return { attachment, data };
    },
  };
}
