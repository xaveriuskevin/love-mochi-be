import { NotificationQueryError, type NotificationQueries } from "@/queries/notifications";
import { ApiError } from "@/utils/errors";
import type { RegisterWebPushSubscriptionInput } from "@/types/api";

function mapError(error: unknown): never {
  if (error instanceof NotificationQueryError) {
    const status = error.databaseCode === "AUTH_REQUIRED" ? 401 : 400;
    const message = status === 401 ? "Authentication required" : "Request validation failed";
    throw new ApiError(status, error.databaseCode, message);
  }
  throw error;
}

export function createDevicesService(queries: NotificationQueries) {
  return {
    async registerWebPush(userId: string, input: RegisterWebPushSubscriptionInput) {
      try { return await queries.registerWebPushSubscription(userId, input); }
      catch (error) { mapError(error); }
    },
    async removeWebPush(userId: string, deviceId: string) {
      try { await queries.removeWebPushSubscription(userId, deviceId); }
      catch (error) { mapError(error); }
    },
  };
}

export type DevicesService = ReturnType<typeof createDevicesService>;
