import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type {
  ActivityStateResponse,
  CreateActivityResponse,
  CreateCareActivityInput,
  CreateTreatmentScheduleInput,
  FeedingHint,
  FeedingSchedule,
  TreatmentScheduleState,
} from "@/types/api";
import type { Database } from "@/types/database";

const iso = z.iso.datetime({ offset: true });
const pet = z.object({ id: z.uuid(), name: z.string(), createdAt: iso });
const statuses = z.object({ sleeping: z.boolean(), alone: z.boolean(), walking: z.boolean() });
const scheduleState = z.enum(["normal", "approaching", "due", "overdue"]);
const feedingSchedule = z.object({ timezone: z.string(), dailyTimes: z.array(z.string()) });
const feedingHint = z.object({ nextFeedAt: iso, lastFedAt: iso.nullable(), state: scheduleState });
const activity = z.object({
  id: z.uuid(), petId: z.uuid(), actorUserId: z.uuid(), actorDisplayName: z.string().nullable(),
  type: z.enum(["feed", "poop", "play", "sleep", "alone", "walk", "custom", "medicine", "ointment"]),
  phase: z.enum(["started", "ended"]).nullable(), label: z.string().nullable(), note: z.string().nullable(),
  treatmentScheduleId: z.uuid().nullable(), scheduledFor: iso.nullable(), occurredAt: iso,
  idempotencyKey: z.string(),
});
const treatmentSchedule = z.object({
  id: z.uuid(), petId: z.uuid(), kind: z.enum(["medicine", "ointment"]), name: z.string(),
  timezone: z.string(), dailyTimes: z.array(z.string()), active: z.boolean(), createdAt: iso, updatedAt: iso,
});
const treatmentHint = z.object({ scheduledFor: iso, lastCompletedAt: iso.nullable(), state: scheduleState });
const treatmentState = z.object({ schedule: treatmentSchedule, hint: treatmentHint });
const stateResponse = z.object({
  pet, activeStatuses: statuses, feedingSchedule: feedingSchedule.nullable(), feedingHint: feedingHint.nullable(),
  treatmentStates: z.array(treatmentState), recentActivities: z.array(activity),
});
const createResponse = z.object({
  activity, state: z.object({ activeStatuses: statuses, feedingHint: feedingHint.nullable(), treatmentState: treatmentState.nullable() }),
});
const historyResult = z.object({
  items: z.array(activity), nextCursorOccurredAt: iso.nullable(), nextCursorId: z.uuid().nullable(),
});

export type CareDomainErrorCode =
  | "PET_NOT_FOUND" | "TREATMENT_SCHEDULE_NOT_FOUND" | "STATUS_ALREADY_ACTIVE"
  | "STATUS_NOT_ACTIVE" | "TREATMENT_NOT_DUE" | "SCHEDULE_SLOT_ALREADY_COMPLETED"
  | "IDEMPOTENCY_CONFLICT" | "RATE_LIMITED" | "TREATMENT_SCHEDULE_LIMIT_REACHED"
  | "VALIDATION_ERROR";

const errorCodes = new Set<CareDomainErrorCode>([
  "PET_NOT_FOUND", "TREATMENT_SCHEDULE_NOT_FOUND", "STATUS_ALREADY_ACTIVE", "STATUS_NOT_ACTIVE",
  "TREATMENT_NOT_DUE", "SCHEDULE_SLOT_ALREADY_COMPLETED", "IDEMPOTENCY_CONFLICT", "RATE_LIMITED",
  "TREATMENT_SCHEDULE_LIMIT_REACHED", "VALIDATION_ERROR",
]);

export class CareQueryError extends Error {
  public constructor(public readonly databaseCode: CareDomainErrorCode) {
    super(databaseCode); this.name = "CareQueryError";
  }
}

function rpcError(error: { message: string }): never {
  if (errorCodes.has(error.message as CareDomainErrorCode)) {
    throw new CareQueryError(error.message as CareDomainErrorCode);
  }
  throw new Error("Care database operation failed");
}

export interface HistoryPage { items: z.infer<typeof activity>[]; nextCursor: string | null }
export interface CareQueries {
  getState(userId: string, petId: string): Promise<ActivityStateResponse>;
  listActivities(userId: string, petId: string, limit: number, cursor: string | null): Promise<HistoryPage>;
  createActivity(userId: string, petId: string, input: CreateCareActivityInput, key: string, hash: string): Promise<CreateActivityResponse>;
  putFeedingSchedule(userId: string, petId: string, timezone: string, times: string[]): Promise<{ feedingSchedule: FeedingSchedule; feedingHint: FeedingHint }>;
  listTreatments(userId: string, petId: string): Promise<{ items: TreatmentScheduleState[] }>;
  createTreatment(userId: string, petId: string, input: CreateTreatmentScheduleInput): Promise<{ treatmentState: TreatmentScheduleState }>;
  updateTreatment(userId: string, petId: string, scheduleId: string, input: { name?: string | undefined; timezone?: string | undefined; dailyTimes?: string[] | undefined }): Promise<{ treatmentState: TreatmentScheduleState }>;
  archiveTreatment(userId: string, petId: string, scheduleId: string): Promise<void>;
}

const cursorSchema = z.object({ occurredAt: iso, id: z.uuid() });
function decodeCursor(cursor: string | null): { occurredAt: string | null; id: string | null } {
  if (cursor === null) return { occurredAt: null, id: null };
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const value = cursorSchema.parse(parsed);
    return { occurredAt: value.occurredAt, id: value.id };
  } catch { throw new CareQueryError("VALIDATION_ERROR"); }
}
function encodeCursor(occurredAt: string | null, id: string | null): string | null {
  if (occurredAt === null || id === null) return null;
  return Buffer.from(JSON.stringify({ occurredAt, id })).toString("base64url");
}

export function createCareQueries(client: SupabaseClient<Database>): CareQueries {
  const rpc = client.rpc.bind(client) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  async function call(name: keyof Database["public"]["Functions"], args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await rpc(name, args);
    if (error !== null) rpcError(error);
    return data;
  }
  return {
    async getState(userId, petId) {
      return stateResponse.parse(await call("get_activity_state", { requested_user_id: userId, requested_pet_id: petId }));
    },
    async listActivities(userId, petId, limit, cursor) {
      const decoded = decodeCursor(cursor);
      const result = historyResult.parse(await call("list_care_activities", {
        requested_user_id: userId, requested_pet_id: petId, requested_limit: limit,
        cursor_occurred_at: decoded.occurredAt, cursor_id: decoded.id,
      }));
      return { items: result.items, nextCursor: encodeCursor(result.nextCursorOccurredAt, result.nextCursorId) };
    },
    async createActivity(userId, petId, input, key, hash) {
      return createResponse.parse(await call("create_care_activity", {
        requested_user_id: userId, requested_pet_id: petId, requested_type: input.type,
        requested_phase: "phase" in input ? input.phase : null,
        requested_label: "label" in input ? input.label : null,
        requested_note: input.note ?? null,
        requested_treatment_schedule_id: "treatmentScheduleId" in input ? input.treatmentScheduleId : null,
        requested_idempotency_key: key, requested_request_hash: hash,
      }));
    },
    async putFeedingSchedule(userId, petId, timezone, times) {
      return z.object({ feedingSchedule, feedingHint }).parse(await call("put_feeding_schedule", {
        requested_user_id: userId, requested_pet_id: petId, requested_timezone: timezone, requested_daily_times: times,
      }));
    },
    async listTreatments(userId, petId) {
      return z.object({ items: z.array(treatmentState) }).parse(await call("list_treatment_schedules", {
        requested_user_id: userId, requested_pet_id: petId,
      }));
    },
    async createTreatment(userId, petId, input) {
      return z.object({ treatmentState }).parse(await call("create_treatment_schedule", {
        requested_user_id: userId, requested_pet_id: petId, requested_kind: input.kind,
        requested_name: input.name, requested_timezone: input.timezone, requested_daily_times: input.dailyTimes,
      }));
    },
    async updateTreatment(userId, petId, scheduleId, input) {
      return z.object({ treatmentState }).parse(await call("update_treatment_schedule", {
        requested_user_id: userId, requested_pet_id: petId, requested_schedule_id: scheduleId,
        requested_name: input.name ?? null, requested_timezone: input.timezone ?? null,
        requested_daily_times: input.dailyTimes ?? null, update_name: input.name !== undefined,
        update_timezone: input.timezone !== undefined, update_daily_times: input.dailyTimes !== undefined,
      }));
    },
    async archiveTreatment(userId, petId, scheduleId) {
      await call("archive_treatment_schedule", { requested_user_id: userId, requested_pet_id: petId, requested_schedule_id: scheduleId });
    },
  };
}
