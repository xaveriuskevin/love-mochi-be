import type { RequestHandler } from "express";
import { z } from "zod";

import type { CareService } from "@/api/care/careService";
import type { CreateCareActivityInput } from "@/types/api";
import { ApiError } from "@/utils/errors";

const uuid = z.uuid();
const note = z.string().trim().max(500).transform((value) => value === "" ? null : value).optional();
const activityInput = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["feed", "poop", "play"]), note }).strict(),
  z.object({ type: z.enum(["sleep", "alone", "walk"]), phase: z.enum(["started", "ended"]), note }).strict(),
  z.object({ type: z.enum(["medicine", "ointment"]), treatmentScheduleId: uuid, note }).strict(),
  z.object({ type: z.literal("custom"), label: z.string().trim().min(1).max(60), note }).strict(),
]);
const time = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
const timezone = z.string().refine((value) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; }
  catch { return false; }
}, "Invalid IANA timezone");
const dailyTimes = z.array(time).min(1).max(8).transform((values, context) => {
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) {
    context.addIssue({ code: "custom", message: "Daily times must be unique" });
    return z.NEVER;
  }
  return sorted;
});
const feedingInput = z.object({ timezone, dailyTimes }).strict();
const treatmentCreate = z.object({
  kind: z.enum(["medicine", "ointment"]), name: z.string().trim().min(1).max(60), timezone, dailyTimes,
}).strict();
const treatmentUpdate = z.object({
  name: z.string().trim().min(1).max(60).optional(), timezone: timezone.optional(), dailyTimes: dailyTimes.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "At least one field is required" });
const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().min(1).optional(),
});
const idempotencyKey = z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/);

function validationError(error: z.ZodError): ApiError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0]; fields[typeof field === "string" ? field : "request"] = issue.message;
  }
  return new ApiError(400, "VALIDATION_ERROR", "Request validation failed", fields);
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}
function params(request: Parameters<RequestHandler>[0]): { petId: string; scheduleId?: string } {
  const petId = parse(uuid, request.params.petId);
  const scheduleId = request.params.scheduleId === undefined ? undefined : parse(uuid, request.params.scheduleId);
  return scheduleId === undefined ? { petId } : { petId, scheduleId };
}

export interface CareController {
  getState: RequestHandler;
  listActivities: RequestHandler;
  createActivity: RequestHandler;
  putFeeding: RequestHandler;
  listTreatments: RequestHandler;
  createTreatment: RequestHandler;
  updateTreatment: RequestHandler;
  archiveTreatment: RequestHandler;
}

export function createCareController(service: CareService): CareController {
  return {
    async getState(request, response, next) {
      try { response.json(await service.getState(request.auth.userId, params(request).petId)); } catch (error) { next(error); }
    },
    async listActivities(request, response, next) {
      try {
        const { petId } = params(request); const query = parse(historyQuery, request.query);
        response.json(await service.listActivities(request.auth.userId, petId, query.limit, query.cursor ?? null));
      } catch (error) { next(error); }
    },
    async createActivity(request, response, next) {
      try {
        const { petId } = params(request); const parsedInput = parse(activityInput, request.body);
        const normalizedInput = { ...parsedInput };
        if (normalizedInput.note === null || normalizedInput.note === undefined) delete normalizedInput.note;
        const input = normalizedInput as CreateCareActivityInput;
        const key = parse(idempotencyKey, request.header("idempotency-key"));
        response.status(201).json(await service.createActivity(request.auth.userId, petId, input, key));
      } catch (error) { next(error); }
    },
    async putFeeding(request, response, next) {
      try {
        const { petId } = params(request); const input = parse(feedingInput, request.body);
        response.json(await service.putFeedingSchedule(request.auth.userId, petId, input.timezone, input.dailyTimes));
      } catch (error) { next(error); }
    },
    async listTreatments(request, response, next) {
      try { response.json(await service.listTreatments(request.auth.userId, params(request).petId)); } catch (error) { next(error); }
    },
    async createTreatment(request, response, next) {
      try {
        const { petId } = params(request); const input = parse(treatmentCreate, request.body);
        response.status(201).json(await service.createTreatment(request.auth.userId, petId, input));
      } catch (error) { next(error); }
    },
    async updateTreatment(request, response, next) {
      try {
        const { petId, scheduleId } = params(request); const input = parse(treatmentUpdate, request.body);
        response.json(await service.updateTreatment(request.auth.userId, petId, scheduleId ?? "", input));
      } catch (error) { next(error); }
    },
    async archiveTreatment(request, response, next) {
      try {
        const { petId, scheduleId } = params(request);
        await service.archiveTreatment(request.auth.userId, petId, scheduleId ?? ""); response.status(204).send();
      } catch (error) { next(error); }
    },
  };
}
