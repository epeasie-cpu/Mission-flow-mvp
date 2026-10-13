import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { appUser, notification, outboundEmail } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";
import { NotFound, ValidationError } from "./errors";
import { leadersToNotify } from "./personnel";

export function assignedNotice(title: string, suspense: string): string {
  return `You were tasked with ${title}, suspense ${suspense}.`;
}

export function chainNotice(name: string, title: string, suspense: string): string {
  return `A member of your chain, ${name}, was tasked with ${title}, suspense ${suspense}.`;
}

export async function fanOutTaskingNotices(
  db: CoreDb,
  actor: Actor,
  input: { taskerId: string; assigneeId: string; title: string; suspense: string },
): Promise<{ count: number }> {
  const [assignee] = await db.select().from(appUser).where(eq(appUser.id, input.assigneeId)).limit(1);
  if (!assignee) throw new NotFound("persona");
  const leaders = await leadersToNotify(db, assignee.id);
  const recipients = [
    {
      id: assignee.id,
      email: assignee.email,
      kind: "assigned" as const,
      body: assignedNotice(input.title, input.suspense),
      subject: `Tasking: ${input.title}`,
    },
    ...leaders.map((leader) => ({
      id: leader.id,
      email: leader.email,
      kind: "chain" as const,
      body: chainNotice(assignee.displayName, input.title, input.suspense),
      subject: `Chain tasking: ${input.title}`,
    })),
  ];
  const seen = new Set<string>();
  let count = 0;
  for (const recipient of recipients) {
    if (seen.has(recipient.id)) continue;
    seen.add(recipient.id);
    const [note] = await db
      .insert(notification)
      .values({
        recipientUserId: recipient.id,
        taskerId: input.taskerId,
        subjectUserId: assignee.id,
        kind: recipient.kind,
        body: recipient.body,
      })
      .returning({ id: notification.id });
    if (!note) throw new Error("notification insert failed");
    const [mail] = await db
      .insert(outboundEmail)
      .values({
        notificationId: note.id,
        recipientUserId: recipient.id,
        toEmail: recipient.email,
        subject: recipient.subject,
        body: recipient.body,
      })
      .returning({ id: outboundEmail.id });
    await writeAudit(db, actor, {
      eventType: "notification.created",
      entityType: "notification",
      entityId: note.id,
      taskerId: input.taskerId,
      payload: {
        kind: recipient.kind,
        recipient_user_id: recipient.id,
        outbound_email_id: mail?.id ?? null,
        subject_user_id: assignee.id,
      },
    });
    count += 1;
  }
  return { count };
}

export type NotificationRow = {
  id: string;
  kind: string;
  body: string;
  taskerId: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export async function listNotifications(db: CoreDb, userId: string): Promise<NotificationRow[]> {
  return db
    .select({
      id: notification.id,
      kind: notification.kind,
      body: notification.body,
      taskerId: notification.taskerId,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    })
    .from(notification)
    .where(eq(notification.recipientUserId, userId))
    .orderBy(desc(notification.createdAt));
}

export async function unreadNotificationCount(db: CoreDb, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notification)
    .where(and(eq(notification.recipientUserId, userId), isNull(notification.readAt)));
  return Number(row?.n ?? 0);
}

export async function markNotificationRead(db: CoreDb, actor: Actor, id: string): Promise<void> {
  if (actor.type !== "user") throw new ValidationError("A person marks a notification read");
  const [row] = await db.select().from(notification).where(eq(notification.id, id)).limit(1);
  if (!row || row.recipientUserId !== actor.userId) throw new NotFound("notification");
  if (row.readAt) return;
  await db.update(notification).set({ readAt: new Date() }).where(eq(notification.id, id));
}

export async function markAllNotificationsRead(db: CoreDb, actor: Actor): Promise<void> {
  if (actor.type !== "user") throw new ValidationError("A person marks a notification read");
  await db
    .update(notification)
    .set({ readAt: new Date() })
    .where(and(eq(notification.recipientUserId, actor.userId), isNull(notification.readAt)));
}

export type OutboundMailRow = {
  id: string;
  toEmail: string;
  subject: string;
  body: string;
  simulated: boolean;
  createdAt: Date;
  recipientName: string | null;
};

export async function listOutboundMail(db: CoreDb): Promise<OutboundMailRow[]> {
  const rows = await db
    .select({
      id: outboundEmail.id,
      toEmail: outboundEmail.toEmail,
      subject: outboundEmail.subject,
      body: outboundEmail.body,
      simulated: outboundEmail.simulated,
      createdAt: outboundEmail.createdAt,
      recipientName: appUser.displayName,
    })
    .from(outboundEmail)
    .leftJoin(appUser, eq(appUser.id, outboundEmail.recipientUserId))
    .orderBy(desc(outboundEmail.createdAt));
  return rows;
}
