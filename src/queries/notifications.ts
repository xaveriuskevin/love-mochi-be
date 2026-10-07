import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { CareNotificationBundle } from "@/notifications/types";
import type { Database } from "@/types/database";
import type { RegisterWebPushSubscriptionInput } from "@/types/api";

export interface NotificationQueries {
  registerWebPushSubscription(
    userId: string,
    input: RegisterWebPushSubscriptionInput,
  ): Promise<{ registered: true }>;
  removeWebPushSubscription(userId: string, deviceId: string): Promise<void>;
  claimCareNotification(actorUserId: string, activityId: string): Promise<CareNotificationBundle | null>;
  disableWebPushSubscription(subscriptionId: string, reason: string): Promise<void>;
}

const uuid = z.uuid();
const careNotificationBundle = z.object({
  activityId: uuid, petId: uuid, actorDisplayName: z.string().nullable(), petName: z.string(),
  type: z.enum(["feed", "poop", "play", "sleep", "alone", "walk", "custom", "medicine", "ointment"]),
  phase: z.enum(["started", "ended"]).nullable(),
  webSubscriptions: z.array(z.object({
    webPushSubscriptionId: uuid,
    endpoint: z.url(),
    expirationTime: z.number().nullable(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  })),
});

export class NotificationQueryError extends Error {
  public constructor(public readonly databaseCode: "AUTH_REQUIRED" | "VALIDATION_ERROR") {
    super(databaseCode); this.name = "NotificationQueryError";
  }
}

export function createNotificationQueries(client: SupabaseClient<Database>): NotificationQueries {
  return {
    async registerWebPushSubscription(userId, input) {
      const { data, error } = await client.rpc("register_web_push_subscription", {
        requested_user_id: userId,
        requested_device_id: input.deviceId,
        requested_endpoint: input.subscription.endpoint,
        requested_expiration_time: input.subscription.expirationTime,
        requested_p256dh: input.subscription.keys.p256dh,
        requested_auth: input.subscription.keys.auth,
      });
      if (error !== null) {
        if (error.message === "AUTH_REQUIRED" || error.message === "VALIDATION_ERROR") {
          throw new NotificationQueryError(error.message);
        }
        throw new Error("Web Push subscription registration failed");
      }
      return z.object({ registered: z.literal(true) }).parse(data);
    },
    async removeWebPushSubscription(userId, deviceId) {
      const { error } = await client.rpc("remove_web_push_subscription", {
        requested_user_id: userId, requested_device_id: deviceId,
      });
      if (error !== null) throw new Error("Web Push subscription removal failed");
    },
    async claimCareNotification(actorUserId, activityId) {
      const { data, error } = await client.rpc("claim_care_notification", {
        requested_user_id: actorUserId, requested_activity_id: activityId,
      });
      if (error !== null) throw new Error("Care notification claim failed");
      return careNotificationBundle.nullable().parse(data);
    },
    async disableWebPushSubscription(subscriptionId, reason) {
      const { error } = await client.rpc("disable_web_push_subscription", {
        requested_subscription_id: subscriptionId, requested_reason: reason,
      });
      if (error !== null) throw new Error("Web Push subscription disable failed");
    },
  };
}
