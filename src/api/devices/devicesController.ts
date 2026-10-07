import type { RequestHandler } from "express";
import { z } from "zod";

import type { DevicesService } from "@/api/devices/devicesService";
import { ApiError } from "@/utils/errors";

const deviceId = z.string().trim().min(1).max(255);
const subscriptionKey = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+={0,2}$/);
const webPushRegistration = z.object({
  deviceId,
  subscription: z.object({
    endpoint: z.url().max(4096).refine((value) => value.startsWith("https://"), "Endpoint must use HTTPS"),
    expirationTime: z.number().positive().nullable(),
    keys: z.object({ p256dh: subscriptionKey, auth: subscriptionKey }).strict(),
  }).strict(),
}).strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0]; fields[typeof field === "string" ? field : "request"] = issue.message;
  }
  throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", fields);
}

export function createDevicesController(service: DevicesService): {
  registerWebPush: RequestHandler;
  removeWebPush: RequestHandler;
} {
  return {
    async registerWebPush(request, response, next) {
      try {
        const body = parse(webPushRegistration, request.body);
        response.status(200).json(await service.registerWebPush(request.auth.userId, body));
      } catch (error) { next(error); }
    },
    async removeWebPush(request, response, next) {
      try {
        const id = parse(deviceId, request.params.deviceId);
        await service.removeWebPush(request.auth.userId, id); response.status(204).send();
      } catch (error) { next(error); }
    },
  };
}
