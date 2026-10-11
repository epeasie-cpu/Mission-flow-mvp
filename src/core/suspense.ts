import { and, desc, eq } from "drizzle-orm";
import { BUSINESS_TZ, businessToday, isSuspenseConflict, suspense as suspenseConfig } from "../config/missionflow.config";
import { holiday, suspensePlan, tasker } from "../db/schema";
import type { SuspenseStage } from "../db/schema";
import type { CoreDb } from "./db";

export type TimelineStage = { stage: string; business_days: number };

export type ComputedPlan = {
  externalSuspense: string;
  stages: SuspenseStage[];
  contingencyBufferDays: number;
  latestAoAssignmentDate: string;
  aoWindowPct: string;
  conflict: boolean;
  warning: string | null;
  totalBusinessDays: number;
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function addCalendarDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  utc.setUTCDate(utc.getUTCDate() + days);
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

export function isWeekend(iso: string): boolean {
  const [year, month, day] = iso.split("-").map(Number);
  const weekday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function isBusinessDay(iso: string, holidays: ReadonlySet<string>): boolean {
  return !isWeekend(iso) && !holidays.has(iso);
}

/** Walk backward from `iso`, not counting `iso` itself. Weekends and holidays are skipped. */
export function subtractBusinessDays(iso: string, count: number, holidays: readonly string[]): string {
  const skip = new Set(holidays);
  let cursor = iso;
  let left = count;
  while (left > 0) {
    cursor = addCalendarDays(cursor, -1);
    if (isBusinessDay(cursor, skip)) left -= 1;
  }
  return cursor;
}

/** Midnight at the start of the business day that contains `now`, as a UTC instant. */
export function businessDayStartUtc(now: Date, tz: string = BUSINESS_TZ): Date {
  const day = businessToday(now, tz);
  const utcMidnight = new Date(`${day}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utcMidnight);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const shown = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"), pick("second"));
  return new Date(utcMidnight.getTime() - (shown - utcMidnight.getTime()));
}

export function computeSuspensePlan(input: {
  externalSuspense: string;
  profile?: TimelineStage[];
  bufferDays?: number;
  holidays?: readonly string[];
  now?: Date;
}): ComputedPlan {
  const supplied =
    input.profile && input.profile.length > 0
      ? input.profile
      : suspenseConfig.standardModel.map((stage) => ({ stage: stage.stage, business_days: stage.business_days }));
  const embeddedBuffer = supplied.find((stage) => stage.stage === "contingency_buffer");
  const profile = embeddedBuffer ? supplied.filter((stage) => stage.stage !== "contingency_buffer") : supplied;
  const bufferDays = embeddedBuffer ? embeddedBuffer.business_days : (input.bufferDays ?? suspenseConfig.defaultContingencyBufferDays);
  const holidays = input.holidays ?? [];
  const profileDays = profile.reduce((sum, stage) => sum + stage.business_days, 0);
  const totalBusinessDays = profileDays + bufferDays;
  const latestAoAssignmentDate = subtractBusinessDays(input.externalSuspense, totalBusinessDays, holidays);
  const aoDays = profile.find((stage) => stage.stage.includes("ao"))?.business_days ?? profile[0]?.business_days ?? 0;
  const pct = totalBusinessDays === 0 ? 0 : aoDays / totalBusinessDays;
  const aoWindowPct = pct.toFixed(4);
  const warning =
    pct < suspenseConfig.aoWindowWarnBelowPct
      ? `AO window is ${(pct * 100).toFixed(1)}% of the plan, under 35%. This warns only and does not block release.`
      : null;

  const stages: SuspenseStage[] = [];
  let boundary = input.externalSuspense;
  const chunks = [...profile, { stage: "contingency_buffer", business_days: bufferDays }].reverse();
  const built: SuspenseStage[] = [];
  for (const chunk of chunks) {
    const start = subtractBusinessDays(boundary, chunk.business_days, holidays);
    built.push({ name: chunk.stage, business_days: chunk.business_days, start, end: boundary });
    boundary = start;
  }
  stages.push(...built.reverse());

  const now = input.now ?? new Date();
  return {
    externalSuspense: input.externalSuspense,
    stages,
    contingencyBufferDays: bufferDays,
    latestAoAssignmentDate,
    aoWindowPct,
    conflict: isSuspenseConflict(latestAoAssignmentDate, now),
    warning,
    totalBusinessDays,
  };
}

export async function loadHolidays(db: CoreDb): Promise<string[]> {
  const rows = await db.select({ day: holiday.day }).from(holiday);
  return rows.map((row) => row.day);
}

export async function nextPlanVersion(db: CoreDb, taskerId: string): Promise<number> {
  const [latest] = await db
    .select({ version: suspensePlan.version })
    .from(suspensePlan)
    .where(eq(suspensePlan.taskerId, taskerId))
    .orderBy(desc(suspensePlan.version))
    .limit(1);
  return (latest?.version ?? 0) + 1;
}

export async function insertPlan(
  db: CoreDb,
  input: {
    taskerId: string;
    plan: ComputedPlan;
    computedBy: string | null;
    conflict?: boolean;
  },
): Promise<string> {
  const version = await nextPlanVersion(db, input.taskerId);
  const [row] = await db
    .insert(suspensePlan)
    .values({
      taskerId: input.taskerId,
      version,
      externalSuspense: input.plan.externalSuspense,
      stages: input.plan.stages,
      contingencyBufferDays: input.plan.contingencyBufferDays,
      latestAoAssignmentDate: input.plan.latestAoAssignmentDate,
      aoWindowPct: input.plan.aoWindowPct,
      conflict: input.conflict ?? input.plan.conflict,
      computedBy: input.computedBy,
    })
    .returning({ id: suspensePlan.id });
  if (!row) throw new Error("suspense plan insert returned no row");
  return row.id;
}

export async function currentPlan(db: CoreDb, taskerId: string) {
  const [row] = await db.select().from(tasker).where(eq(tasker.id, taskerId)).limit(1);
  if (!row?.currentSuspensePlanId) return undefined;
  const [plan] = await db
    .select()
    .from(suspensePlan)
    .where(and(eq(suspensePlan.id, row.currentSuspensePlanId), eq(suspensePlan.taskerId, taskerId)))
    .limit(1);
  return plan;
}
