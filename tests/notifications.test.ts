import { describe, expect, it } from "bun:test";
import pino from "pino";

import { buildWebPushMessage, createCareNotifier } from "@/notifications/careNotifier";
import type { CareNotificationBundle } from "@/notifications/types";
import type { WebPushClient } from "@/notifications/webPushClient";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const PET = "33333333-3333-4333-8333-333333333333";
const ACTIVITY = "77777777-7777-4777-8777-777777777777";
const WEB_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WEB_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function subscription(id: string) {
  return {
    webPushSubscriptionId: id, endpoint: `https://push.example.test/${id}`,
    expirationTime: null, keys: { p256dh: "public-key", auth: "auth-key" },
  };
}

function bundle(type: CareNotificationBundle["type"] = "feed"): CareNotificationBundle {
  return {
    activityId: ACTIVITY, petId: PET, actorDisplayName: "Kevin", petName: "Mochi",
    type, phase: null, webSubscriptions: [subscription(WEB_A), subscription(WEB_B)],
  };
}

function harness(delivery: CareNotificationBundle | null = bundle()) {
  const claims: Array<{ actor: string; activity: string }> = [];
  const disabled: Array<{ id: string; reason: string }> = [];
  let claimed = false;
  const queries = {
    claimCareNotification(actor: string, activity: string) {
      claims.push({ actor, activity });
      // Mirrors the single-use DB claim: only the first call returns recipients.
      const result = claimed ? null : delivery; claimed = true; return Promise.resolve(result);
    },
    disableWebPushSubscription(id: string, reason: string) { disabled.push({ id, reason }); return Promise.resolve(); },
  };
  return { queries, claims, disabled };
}

describe("care notification copy", () => {
  it("uses generic payload copy for custom and all treatment care", () => {
    for (const type of ["custom", "medicine", "ointment"] as const) {
      const message = buildWebPushMessage(bundle(type));
      expect(message.body).toBe("Kevin logged care for Mochi");
      expect(message.data.url).toBe(`/timeline?activityId=${ACTIVITY}`);
    }
  });

  it("produces actor-aware copy without pair or auth data", () => {
    const message = buildWebPushMessage(bundle("feed"));
    expect(message.body).toBe("Kevin fed Mochi");
    expect(Object.keys(message.data).sort()).toEqual(["activityId", "kind", "petId", "url"]);
  });

  it("produces walk start and end copy", () => {
    expect(buildWebPushMessage({ ...bundle("walk"), phase: "started" }).body).toBe("Kevin took Mochi for a walk");
    expect(buildWebPushMessage({ ...bundle("walk"), phase: "ended" }).body).toBe("Kevin brought Mochi back from a walk");
  });
});

describe("instant care notifier", () => {
  it("sends once to every partner subscription and never resends on replay", async () => {
    const state = harness(); const sent: Array<{ endpoint: string; payload: string }> = [];
    const webPush: WebPushClient = {
      send(target, payload) { sent.push({ endpoint: target.endpoint, payload }); return Promise.resolve(); },
    };
    const notifier = createCareNotifier(state.queries, webPush, pino({ enabled: false }));
    await notifier.deliver(ACTOR, ACTIVITY);
    await notifier.deliver(ACTOR, ACTIVITY);
    expect(state.claims).toEqual([{ actor: ACTOR, activity: ACTIVITY }, { actor: ACTOR, activity: ACTIVITY }]);
    expect(sent.map((item) => item.endpoint)).toEqual([`https://push.example.test/${WEB_A}`, `https://push.example.test/${WEB_B}`]);
    expect(JSON.parse(sent[0]?.payload ?? "{}")).toEqual({
      title: "Mochi update", body: "Kevin fed Mochi",
      data: { kind: "care_activity", petId: PET, activityId: ACTIVITY, url: `/timeline?activityId=${ACTIVITY}` },
    });
  });

  it("disables gone subscriptions, drops transient failures, and keeps sending to others", async () => {
    const state = harness(); const delivered: string[] = [];
    const webPush: WebPushClient = {
      send(target) {
        if (target.webPushSubscriptionId === WEB_A) {
          return Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 }));
        }
        delivered.push(target.webPushSubscriptionId); return Promise.resolve();
      },
    };
    await createCareNotifier(state.queries, webPush, pino({ enabled: false })).deliver(ACTOR, ACTIVITY);
    expect(state.disabled).toEqual([{ id: WEB_A, reason: "HTTP_410" }]);
    expect(delivered).toEqual([WEB_B]);

    const transient = harness();
    const unavailable: WebPushClient = {
      send: () => Promise.reject(Object.assign(new Error("unavailable"), { statusCode: 503 })),
    };
    await createCareNotifier(transient.queries, unavailable, pino({ enabled: false })).deliver(ACTOR, ACTIVITY);
    expect(transient.disabled).toEqual([]);
  });

  it("does nothing when the partner has no subscriptions", async () => {
    const state = harness({ ...bundle(), webSubscriptions: [] }); let sends = 0;
    const webPush: WebPushClient = { send: () => { sends += 1; return Promise.resolve(); } };
    await createCareNotifier(state.queries, webPush, pino({ enabled: false })).deliver(ACTOR, ACTIVITY);
    expect(sends).toBe(0);
  });

  it("never throws from fire-and-forget notify even when the claim fails", async () => {
    const queries = {
      claimCareNotification: () => Promise.reject(new Error("db down")),
      disableWebPushSubscription: () => Promise.resolve(),
    };
    const notifier = createCareNotifier(queries, { send: () => Promise.resolve() }, pino({ enabled: false }));
    expect(() => { notifier.notify(ACTOR, ACTIVITY); }).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
