import type { Logger } from "pino";

import type { CareActivityWebPushPayload, CareNotificationBundle } from "@/notifications/types";
import { webPushHttpStatus, type WebPushClient } from "@/notifications/webPushClient";
import type { NotificationQueries } from "@/queries/notifications";

export interface CareNotifier {
  // Fire-and-forget: never throws and never delays the care response.
  notify(actorUserId: string, activityId: string): void;
}

function notificationBody(bundle: CareNotificationBundle): string {
  const actor = bundle.actorDisplayName ?? "Your co-parent";
  const pet = bundle.petName;
  if (["custom", "medicine", "ointment"].includes(bundle.type)) return `${actor} logged care for ${pet}`;
  if (bundle.type === "feed") return `${actor} fed ${pet}`;
  if (bundle.type === "poop") return `${actor} logged a poop for ${pet}`;
  if (bundle.type === "play") return `${actor} played with ${pet}`;
  if (bundle.type === "sleep") return bundle.phase === "started"
    ? `${actor} marked ${pet} as sleeping` : `${actor} marked ${pet} as awake`;
  if (bundle.type === "walk") return bundle.phase === "started"
    ? `${actor} took ${pet} for a walk` : `${actor} brought ${pet} back from a walk`;
  return bundle.phase === "started"
    ? `${actor} marked ${pet} as alone` : `${actor} marked ${pet} as no longer alone`;
}

export function buildWebPushMessage(bundle: CareNotificationBundle): CareActivityWebPushPayload {
  return {
    title: "Mochi update", body: notificationBody(bundle),
    data: {
      kind: "care_activity", petId: bundle.petId, activityId: bundle.activityId,
      url: `/timeline?activityId=${encodeURIComponent(bundle.activityId)}`,
    },
  };
}

export function createCareNotifier(
  queries: Pick<NotificationQueries, "claimCareNotification" | "disableWebPushSubscription">,
  webPush: WebPushClient,
  logger: Logger,
): CareNotifier & { deliver(actorUserId: string, activityId: string): Promise<void> } {
  async function deliver(actorUserId: string, activityId: string): Promise<void> {
    // The claim is single-use per activity, so idempotent replays return null.
    const bundle = await queries.claimCareNotification(actorUserId, activityId);
    if (bundle === null || bundle.webSubscriptions.length === 0) return;
    const payload = JSON.stringify(buildWebPushMessage(bundle));
    await Promise.all(bundle.webSubscriptions.map(async (subscription) => {
      try {
        await webPush.send(subscription, payload);
      } catch (error) {
        const status = webPushHttpStatus(error);
        if (status === 404 || status === 410) {
          await queries.disableWebPushSubscription(subscription.webPushSubscriptionId, `HTTP_${String(status)}`);
        } else {
          // Best effort by design: a lost notification is acceptable.
          logger.warn({ activityId, status }, "Care Web Push send failed");
        }
      }
    }));
  }

  return {
    deliver,
    notify(actorUserId, activityId) {
      void deliver(actorUserId, activityId).catch((error: unknown) => {
        logger.warn({ activityId, err: error }, "Care notification failed");
      });
    },
  };
}
