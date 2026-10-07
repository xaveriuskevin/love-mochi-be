import { createHash } from "node:crypto";

import type { CareNotifier } from "@/notifications/careNotifier";
import { CareQueryError, type CareQueries } from "@/queries/care";
import type { CreateCareActivityInput, CreateTreatmentScheduleInput } from "@/types/api";
import { ApiError } from "@/utils/errors";

const mapping: Record<string, { status: number; message: string }> = {
  PET_NOT_FOUND: { status: 404, message: "Pet not found" },
  TREATMENT_SCHEDULE_NOT_FOUND: { status: 404, message: "Treatment schedule not found" },
  STATUS_ALREADY_ACTIVE: { status: 409, message: "Status is already active" },
  STATUS_NOT_ACTIVE: { status: 409, message: "Status is not active" },
  TREATMENT_NOT_DUE: { status: 409, message: "Treatment is not due" },
  SCHEDULE_SLOT_ALREADY_COMPLETED: { status: 409, message: "Schedule slot is already completed" },
  IDEMPOTENCY_CONFLICT: { status: 409, message: "Idempotency key was used for another action" },
  RATE_LIMITED: { status: 429, message: "Too many activities; retry shortly" },
  TREATMENT_SCHEDULE_LIMIT_REACHED: { status: 409, message: "Treatment schedule limit reached" },
  VALIDATION_ERROR: { status: 400, message: "Request validation failed" },
};

function mapError(error: unknown): never {
  if (!(error instanceof CareQueryError)) throw error;
  const value = mapping[error.databaseCode];
  if (value === undefined) throw error;
  throw new ApiError(value.status, error.databaseCode, value.message);
}

export function createCareService(queries: CareQueries, notifier?: CareNotifier) {
  return {
    async getState(userId: string, petId: string) {
      try { return await queries.getState(userId, petId); } catch (error) { mapError(error); }
    },
    async listActivities(userId: string, petId: string, limit: number, cursor: string | null) {
      try { return await queries.listActivities(userId, petId, limit, cursor); } catch (error) { mapError(error); }
    },
    async createActivity(userId: string, petId: string, input: CreateCareActivityInput, key: string) {
      const hash = createHash("sha256")
        .update(JSON.stringify({ petId, input }))
        .digest("hex");
      let result: Awaited<ReturnType<CareQueries["createActivity"]>>;
      try { result = await queries.createActivity(userId, petId, input, key, hash); } catch (error) { mapError(error); }
      // Partner sees it instantly via Web Push (best effort) and Supabase Realtime.
      notifier?.notify(userId, result.activity.id);
      return result;
    },
    async putFeedingSchedule(userId: string, petId: string, timezone: string, times: string[]) {
      try { return await queries.putFeedingSchedule(userId, petId, timezone, times); } catch (error) { mapError(error); }
    },
    async listTreatments(userId: string, petId: string) {
      try { return await queries.listTreatments(userId, petId); } catch (error) { mapError(error); }
    },
    async createTreatment(userId: string, petId: string, input: CreateTreatmentScheduleInput) {
      try { return await queries.createTreatment(userId, petId, input); } catch (error) { mapError(error); }
    },
    async updateTreatment(userId: string, petId: string, scheduleId: string, input: { name?: string | undefined; timezone?: string | undefined; dailyTimes?: string[] | undefined }) {
      try { return await queries.updateTreatment(userId, petId, scheduleId, input); } catch (error) { mapError(error); }
    },
    async archiveTreatment(userId: string, petId: string, scheduleId: string) {
      try { await queries.archiveTreatment(userId, petId, scheduleId); } catch (error) { mapError(error); }
    },
  };
}

export type CareService = ReturnType<typeof createCareService>;
