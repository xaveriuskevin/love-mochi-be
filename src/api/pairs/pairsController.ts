import type { RequestHandler } from "express";
import { z } from "zod";

import type { PairsService } from "@/api/pairs/pairsService";
import { ApiError } from "@/utils/errors";

const petNameSchema = z.object({
  petName: z.string().trim().min(1).max(40),
}).strict();

const inviteCodeSchema = z.object({
  inviteCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/),
}).strict();

const emptyBodySchema = z.object({}).strict();

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);

  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    fields[typeof field === "string" ? field : "body"] = issue.message;
  }

  throw new ApiError(
    400,
    "VALIDATION_ERROR",
    "Request validation failed",
    fields,
  );
}

export function createPairsController(service: PairsService): {
  createPair: RequestHandler;
  joinPair: RequestHandler;
  rotateInvite: RequestHandler;
} {
  return {
    async createPair(request, response, next) {
      try {
        const body = parseBody(petNameSchema, request.body);
        const result = await service.createPair(request.auth.userId, body.petName);
        response.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },

    async joinPair(request, response, next) {
      try {
        const body = parseBody(inviteCodeSchema, request.body);
        const result = await service.joinPair(request.auth.userId, body.inviteCode);
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },

    async rotateInvite(request, response, next) {
      try {
        parseBody(emptyBodySchema, request.body ?? {});
        const result = await service.rotateInvite(request.auth.userId);
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  };
}
