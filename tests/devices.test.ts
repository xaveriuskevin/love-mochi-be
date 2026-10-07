import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import pino from "pino";
import request from "supertest";

import type { AuthVerifier } from "@/middleware/auth";
import type { NotificationQueries } from "@/queries/notifications";
import type { PairingQueries } from "@/queries/pairing";
import { createApp } from "@/server";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "55555555-5555-4555-8555-555555555555";
let webRegistration: { userId: string; deviceId: string; endpoint: string } | null = null;
const webRemovals: Array<{ userId: string; deviceId: string }> = [];
const notifications: NotificationQueries = {
  registerWebPushSubscription(userId, input) {
    webRegistration = { userId, deviceId: input.deviceId, endpoint: input.subscription.endpoint };
    return Promise.resolve({ registered: true });
  },
  removeWebPushSubscription(userId, deviceId) {
    webRemovals.push({ userId, deviceId }); return Promise.resolve();
  },
  claimCareNotification: () => Promise.resolve(null),
  disableWebPushSubscription: () => Promise.resolve(),
};
const pairing = {
  getWorkspace: () => Promise.reject(new Error("unused")), createPair: () => Promise.reject(new Error("unused")),
  joinPair: () => Promise.reject(new Error("unused")), rotateInvite: () => Promise.reject(new Error("unused")),
} satisfies PairingQueries;
const auth: AuthVerifier = {
  verifyAccessToken(token) { return Promise.resolve(token === "other" ? { id: OTHER } : token === "valid" ? { id: USER } : null); },
};
const app = createApp(pino({ enabled: false }), {
  authVerifier: auth, pairingQueries: pairing, notificationQueries: notifications,
  corsAllowedOrigins: new Set(["http://localhost:5173"]),
});

describe("Web Push subscription API", () => {
  const body = {
    deviceId: " browser-a ",
    subscription: {
      endpoint: "https://push.example.test/subscription-a",
      expirationTime: null,
      keys: { p256dh: "public_key-A", auth: "auth_key-A" },
    },
  };

  it("registers exact browser subscription data for only the authenticated user", async () => {
    const response = await request(server).post("/api/devices/web-push-subscriptions")
      .set("authorization", "Bearer valid").send(body);
    expect(response.status).toBe(200); expect(response.body as object).toEqual({ registered: true });
    expect(webRegistration).toEqual({
      userId: USER, deviceId: "browser-a", endpoint: "https://push.example.test/subscription-a",
    });
  });

  it("rejects malformed subscriptions and client-supplied authority", async () => {
    for (const invalid of [
      { ...body, subscription: { ...body.subscription, endpoint: "http://push.example.test/a" } },
      { ...body, subscription: { ...body.subscription, keys: { p256dh: "bad key", auth: "ok" } } },
      { ...body, userId: OTHER },
    ]) {
      const response = await request(server).post("/api/devices/web-push-subscriptions")
        .set("authorization", "Bearer valid").send(invalid);
      expect(response.status).toBe(400);
    }
  });

  it("scopes removal to the authenticated owner", async () => {
    await request(server).delete("/api/devices/web-push-subscriptions/browser-a")
      .set("authorization", "Bearer valid");
    await request(server).delete("/api/devices/web-push-subscriptions/browser-a")
      .set("authorization", "Bearer other");
    expect(webRemovals).toEqual([
      { userId: USER, deviceId: "browser-a" }, { userId: OTHER, deviceId: "browser-a" },
    ]);
  });

  it("allows configured local origins, rejects others, and permits origin-less clients", async () => {
    const allowed = await request(server).options("/api/devices/web-push-subscriptions")
      .set("origin", "http://localhost:5173");
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const denied = await request(server).post("/api/devices/web-push-subscriptions")
      .set("origin", "https://evil.example").set("authorization", "Bearer valid").send(body);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed" } });
    const originless = await request(server).post("/api/devices/web-push-subscriptions")
      .set("authorization", "Bearer valid").send(body);
    expect(originless.status).toBe(200);
  });
});
let server: Server;
beforeAll(async () => { server = app.listen(0); await once(server, "listening"); });
afterAll(() => { server.close(); });

