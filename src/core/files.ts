import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { STORED_DOCUMENT_MAX_BYTES, storedDocument } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";
import { NotFound, ValidationError } from "./errors";
import { authorized, canViewTasker } from "./policy";
import { mustTasker } from "./tasker-store";

export const FILE_MAX_BYTES = STORED_DOCUMENT_MAX_BYTES;

const EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
};

export type UploadInput = {
  fileName: string;
  mime: string;
  content: Buffer;
};

export function classifyUpload(fileName: string, mime: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "";
  const ext = base.includes(".") ? (base.split(".").pop() ?? "").toLowerCase() : "";
  const expected = EXTENSIONS[ext];
  if (!expected) throw new ValidationError("File type is not allowed");
  const given = mime.trim().toLowerCase();
  if (given && given !== "application/octet-stream" && given !== expected) {
    throw new ValidationError("File type is not allowed");
  }
  return expected;
}

export function sha256Buffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertSize(content: Buffer): void {
  if (content.length === 0 || content.length > FILE_MAX_BYTES) {
    throw new ValidationError("Each file must be between 1 byte and 10 MB");
  }
}

export async function insertStoredDocument(db: CoreDb, actor: Actor, taskerId: string, input: UploadInput) {
  if (actor.type !== "user") throw new ValidationError("A person uploads a document");
  const mime = classifyUpload(input.fileName, input.mime);
  assertSize(input.content);
  const fileName = (input.fileName.split(/[/\\]/).pop() ?? "file").slice(0, 180);
  const digest = sha256Buffer(input.content);
  const [row] = await db
    .insert(storedDocument)
    .values({
      taskerId,
      fileName,
      mime,
      byteSize: input.content.length,
      sha256: digest,
      content: input.content,
      uploadedBy: actor.userId,
    })
    .returning({
      id: storedDocument.id,
      fileName: storedDocument.fileName,
      mime: storedDocument.mime,
      byteSize: storedDocument.byteSize,
      sha256: storedDocument.sha256,
      createdAt: storedDocument.createdAt,
    });
  if (!row) throw new Error("stored document insert failed");
  await writeAudit(db, actor, {
    eventType: "stored_document.uploaded",
    entityType: "stored_document",
    entityId: row.id,
    taskerId,
    payload: { file_name: row.fileName, mime: row.mime, byte_size: row.byteSize, sha256: row.sha256 },
  });
  return row;
}

export async function uploadStoredDocument(db: CoreDb, actor: Actor, taskerId: string, input: UploadInput) {
  return authorized(db, actor, "files.upload", { taskerId }, async (tx) => {
    await mustTasker(tx, taskerId);
    return insertStoredDocument(tx, actor, taskerId, input);
  });
}

export type StoredDocumentMeta = {
  id: string;
  fileName: string;
  mime: string;
  byteSize: number;
  sha256: string;
  uploadedBy: string;
  createdAt: Date;
};

export async function listStoredDocuments(db: CoreDb, actor: Actor, taskerId: string): Promise<StoredDocumentMeta[]> {
  const view = await canViewTasker(db, actor, taskerId);
  if (view !== "full") return [];
  return db
    .select({
      id: storedDocument.id,
      fileName: storedDocument.fileName,
      mime: storedDocument.mime,
      byteSize: storedDocument.byteSize,
      sha256: storedDocument.sha256,
      uploadedBy: storedDocument.uploadedBy,
      createdAt: storedDocument.createdAt,
    })
    .from(storedDocument)
    .where(eq(storedDocument.taskerId, taskerId))
    .orderBy(desc(storedDocument.createdAt));
}

export async function readStoredDocument(db: CoreDb, actor: Actor, id: string) {
  const [row] = await db.select().from(storedDocument).where(eq(storedDocument.id, id)).limit(1);
  if (!row) throw new NotFound("document");
  const view = await canViewTasker(db, actor, row.taskerId);
  if (view !== "full") throw new NotFound("document");
  return row;
}
