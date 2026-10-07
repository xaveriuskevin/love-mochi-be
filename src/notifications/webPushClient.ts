import webPush from "web-push";

import type { DeliveryWebSubscription } from "@/notifications/types";

export interface WebPushClient {
  send(subscription: DeliveryWebSubscription, payload: string): Promise<void>;
}

export function createWebPushClient(
  subject: string,
  publicKey: string,
  privateKey: string,
): WebPushClient {
  webPush.setVapidDetails(subject, publicKey, privateKey);
  return {
    async send(subscription, payload) {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime,
        keys: subscription.keys,
      }, payload, { TTL: 60 });
    },
  };
}

export function webPushHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return null;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}
