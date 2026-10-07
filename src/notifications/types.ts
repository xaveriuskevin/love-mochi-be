import type { CareActivityWebPushData } from "@/types/api";

export type DeliveryWebSubscription = {
  webPushSubscriptionId: string;
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

export type CareNotificationBundle = {
  activityId: string;
  petId: string;
  actorDisplayName: string | null;
  petName: string;
  type: "feed" | "poop" | "play" | "sleep" | "alone" | "walk" | "custom" | "medicine" | "ointment";
  phase: "started" | "ended" | null;
  webSubscriptions: DeliveryWebSubscription[];
};

export type CareActivityWebPushPayload = {
  title: "Mochi update";
  body: string;
  data: CareActivityWebPushData;
};
