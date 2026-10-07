import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import pino from "pino";
import request from "supertest";

import type { AuthVerifier } from "@/middleware/auth";
import type { CareNotifier } from "@/notifications/careNotifier";
import { CareQueryError, type CareQueries } from "@/queries/care";
import type { PairingQueries } from "@/queries/pairing";
import { createApp } from "@/server";
import type {
  ActivityStateResponse, CareActivity, CreateCareActivityInput, FeedingHint,
  TreatmentScheduleState,
} from "@/types/api";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "55555555-5555-4555-8555-555555555555";
const PET = "33333333-3333-4333-8333-333333333333";
const SCHEDULE = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-08-25T00:00:00.000Z";
const feedingHint: FeedingHint = { nextFeedAt: "2026-08-25T01:00:00.000Z", lastFedAt: null, state: "approaching" };
const treatmentState: TreatmentScheduleState = {
  schedule: {
    id: SCHEDULE, petId: PET, kind: "medicine", name: "Heart tablet", timezone: "Asia/Jakarta",
    dailyTimes: ["08:00", "20:00"], active: true, createdAt: NOW, updatedAt: NOW,
  },
  hint: { scheduledFor: "2026-08-25T01:00:00.000Z", lastCompletedAt: null, state: "due" },
};
const baseActivity: CareActivity = {
  id: "77777777-7777-4777-8777-777777777777", petId: PET, actorUserId: USER,
  actorDisplayName: "Kevin", type: "feed", phase: null, label: null, note: null,
  treatmentScheduleId: null, scheduledFor: "2026-08-25T01:00:00.000Z", occurredAt: NOW,
  idempotencyKey: "tap-1",
};
const state: ActivityStateResponse = {
  pet: { id: PET, name: "Mochi", createdAt: NOW }, activeStatuses: { sleeping: false, alone: false, walking: false },
  feedingSchedule: { timezone: "Asia/Jakarta", dailyTimes: ["08:00", "20:00"] }, feedingHint,
  treatmentStates: [treatmentState], recentActivities: [baseActivity],
};

let nextError: string | null = null;
let activityCall: { userId: string; petId: string; input: CreateCareActivityInput; key: string; hash: string } | null = null;
let scheduleCall: { timezone: string; times: string[] } | null = null;
let updateCall: { scheduleId: string; input: object } | null = null;
let archivedSchedule: string | null = null;
let stateUser: string | null = null;
function fail(): void {
  if (nextError !== null) { const value = nextError; nextError = null; throw new CareQueryError(value as never); }
}

const careQueries: CareQueries = {
  getState(userId) { fail(); stateUser = userId; return Promise.resolve(state); },
  listActivities(_userId, _petId, _limit, cursor) {
    fail(); return Promise.resolve({ items: [baseActivity], nextCursor: cursor === null ? "next-page" : null });
  },
  createActivity(userId, petId, input, key, hash) {
    fail(); activityCall = { userId, petId, input, key, hash };
    const isTreatment = input.type === "medicine" || input.type === "ointment";
    const activity: CareActivity = {
      ...baseActivity, type: input.type,
      phase: "phase" in input ? input.phase : null,
      label: "label" in input ? input.label : isTreatment ? treatmentState.schedule.name : null,
      note: input.note ?? null,
      treatmentScheduleId: "treatmentScheduleId" in input ? input.treatmentScheduleId : null,
      scheduledFor: isTreatment ? treatmentState.hint.scheduledFor : null,
      idempotencyKey: key,
    };
    return Promise.resolve({ activity, state: { activeStatuses: state.activeStatuses, feedingHint, treatmentState: isTreatment ? treatmentState : null } });
  },
  putFeedingSchedule(_userId, _petId, timezone, times) {
    fail(); scheduleCall = { timezone, times };
    return Promise.resolve({ feedingSchedule: { timezone, dailyTimes: times }, feedingHint });
  },
  listTreatments() { fail(); return Promise.resolve({ items: [treatmentState] }); },
  createTreatment(_userId, _petId, input) {
    fail(); return Promise.resolve({ treatmentState: { ...treatmentState, schedule: { ...treatmentState.schedule, ...input } } });
  },
  updateTreatment(_userId, _petId, scheduleId, input) {
    fail(); updateCall = { scheduleId, input };
    const schedule = { ...treatmentState.schedule };
    if (input.name !== undefined) schedule.name = input.name;
    if (input.timezone !== undefined) schedule.timezone = input.timezone;
    if (input.dailyTimes !== undefined) schedule.dailyTimes = input.dailyTimes;
    return Promise.resolve({ treatmentState: { ...treatmentState, schedule } });
  },
  archiveTreatment(_userId, _petId, scheduleId) { fail(); archivedSchedule = scheduleId; return Promise.resolve(); },
};
const pairingQueries = {
  getWorkspace: () => Promise.reject(new Error("unused")), createPair: () => Promise.reject(new Error("unused")),
  joinPair: () => Promise.reject(new Error("unused")), rotateInvite: () => Promise.reject(new Error("unused")),
} satisfies PairingQueries;
const authVerifier: AuthVerifier = {
  verifyAccessToken(token) { return Promise.resolve(token === "other" ? { id: OTHER_USER } : token === "valid" ? { id: USER } : null); },
};
const notified: Array<{ actorUserId: string; activityId: string }> = [];
const careNotifier: CareNotifier = { notify(actorUserId, activityId) { notified.push({ actorUserId, activityId }); } };
const app = createApp(pino({ enabled: false }), { authVerifier, pairingQueries, careQueries, careNotifier });
let server: Server;
beforeAll(async () => { server = app.listen(0); await once(server, "listening"); });
afterAll(() => { server.close(); });

type ErrorBody = { error: { code: string; fields?: Record<string, string> } };

describe("care activity API", () => {
  it("requires verified authentication", async () => {
    const response = await request(server).get(`/api/pets/${PET}/activity-state`);
    expect(response.status).toBe(401); expect((response.body as ErrorBody).error.code).toBe("AUTH_REQUIRED");
  });

  it("returns complete derived state and scopes it to authenticated identity", async () => {
    const response = await request(server).get(`/api/pets/${PET}/activity-state`).set("authorization", "Bearer other");
    expect(response.status).toBe(200); expect(response.body as ActivityStateResponse).toEqual(state);
    expect(stateUser).toBe(OTHER_USER);
  });

  it("creates every point, stateful, custom, and treatment kind", async () => {
    const inputs: CreateCareActivityInput[] = [
      { type: "feed" }, { type: "poop", note: "Normal" }, { type: "play" },
      { type: "sleep", phase: "started" }, { type: "sleep", phase: "ended" },
      { type: "alone", phase: "started" }, { type: "alone", phase: "ended" },
      { type: "walk", phase: "started" }, { type: "walk", phase: "ended" },
      { type: "custom", label: "Vet check", note: "  " },
      { type: "medicine", treatmentScheduleId: SCHEDULE },
      { type: "ointment", treatmentScheduleId: SCHEDULE },
    ];
    for (const [index, input] of inputs.entries()) {
      const response = await request(server).post(`/api/pets/${PET}/activities`)
        .set("authorization", "Bearer valid").set("idempotency-key", `tap-${String(index)}`).send(input);
      expect(response.status).toBe(201);
      expect((response.body as { activity: CareActivity }).activity.type).toBe(input.type);
    }
    expect(activityCall?.userId).toBe(USER); expect(activityCall?.petId).toBe(PET);
    expect(activityCall?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("notifies the partner for the authenticated actor only after the activity is saved", async () => {
    notified.length = 0;
    const created = await request(server).post(`/api/pets/${PET}/activities`)
      .set("authorization", "Bearer other").set("idempotency-key", "notify-ok").send({ type: "feed" });
    expect(created.status).toBe(201);
    expect(notified).toEqual([
      { actorUserId: OTHER_USER, activityId: (created.body as { activity: CareActivity }).activity.id },
    ]);

    nextError = "STATUS_ALREADY_ACTIVE";
    const rejected = await request(server).post(`/api/pets/${PET}/activities`)
      .set("authorization", "Bearer valid").set("idempotency-key", "notify-fail").send({ type: "sleep", phase: "started" });
    expect(rejected.status).toBe(409);
    expect(notified).toHaveLength(1);
  });

  it("rejects actor/time impersonation, malformed keys, and field limits", async () => {
    const cases = [
      { body: { type: "feed", actorUserId: OTHER_USER }, key: "ok" },
      { body: { type: "feed", occurredAt: NOW }, key: "ok" },
      { body: { type: "custom", label: "x".repeat(61) }, key: "ok" },
      { body: { type: "feed", note: "x".repeat(501) }, key: "ok" },
      { body: { type: "feed" }, key: "x".repeat(129) },
    ];
    for (const value of cases) {
      const response = await request(server).post(`/api/pets/${PET}/activities`)
        .set("authorization", "Bearer valid").set("idempotency-key", value.key).send(value.body);
      expect(response.status).toBe(400); expect((response.body as ErrorBody).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("maps atomic status, slot, idempotency, rate, pet, and treatment failures", async () => {
    const cases = [
      ["PET_NOT_FOUND", 404], ["TREATMENT_SCHEDULE_NOT_FOUND", 404], ["STATUS_ALREADY_ACTIVE", 409],
      ["STATUS_NOT_ACTIVE", 409], ["TREATMENT_NOT_DUE", 409], ["SCHEDULE_SLOT_ALREADY_COMPLETED", 409],
      ["IDEMPOTENCY_CONFLICT", 409], ["RATE_LIMITED", 429],
    ] as const;
    for (const [code, status] of cases) {
      nextError = code;
      const response = await request(server).post(`/api/pets/${PET}/activities`)
        .set("authorization", "Bearer valid").set("idempotency-key", "tap-error").send({ type: "feed" });
      expect(response.status).toBe(status); expect((response.body as ErrorBody).error.code).toBe(code);
    }
  });

  it("supports stable paginated history and validates limits/cursors", async () => {
    const first = await request(server).get(`/api/pets/${PET}/activities?limit=50`).set("authorization", "Bearer valid");
    const second = await request(server).get(`/api/pets/${PET}/activities?limit=50&cursor=next-page`).set("authorization", "Bearer valid");
    const invalid = await request(server).get(`/api/pets/${PET}/activities?limit=51`).set("authorization", "Bearer valid");
    expect(first.status).toBe(200); expect(first.body as object).toMatchObject({ nextCursor: "next-page" });
    expect(second.body as object).toMatchObject({ nextCursor: null }); expect(invalid.status).toBe(400);
  });
});

describe("feeding and treatment schedules", () => {
  it("normalizes daily times and validates timezone, uniqueness, and bounds", async () => {
    const good = await request(server).put(`/api/pets/${PET}/feeding-schedule`).set("authorization", "Bearer valid")
      .send({ timezone: "America/New_York", dailyTimes: ["20:00", "08:00"] });
    expect(good.status).toBe(200); expect(scheduleCall).toEqual({ timezone: "America/New_York", times: ["08:00", "20:00"] });
    for (const body of [
      { timezone: "Not/AZone", dailyTimes: ["08:00"] },
      { timezone: "UTC", dailyTimes: ["08:00", "08:00"] },
      { timezone: "UTC", dailyTimes: [] },
      { timezone: "UTC", dailyTimes: ["8:00"] },
    ]) {
      const response = await request(server).put(`/api/pets/${PET}/feeding-schedule`).set("authorization", "Bearer valid").send(body);
      expect(response.status).toBe(400);
    }
  });

  it("returns deterministic contracted hint timestamps including DST boundaries", async () => {
    const dstState: ActivityStateResponse = {
      ...state,
      feedingHint: { nextFeedAt: "2026-03-08T07:30:00.000Z", lastFedAt: null, state: "due" },
      treatmentStates: [{ ...treatmentState, hint: {
        scheduledFor: "2026-11-01T06:30:00.000Z", lastCompletedAt: null, state: "approaching",
      } }],
    };
    const original = careQueries.getState.bind(careQueries);
    careQueries.getState = () => Promise.resolve(dstState);
    const response = await request(server).get(`/api/pets/${PET}/activity-state`).set("authorization", "Bearer valid");
    careQueries.getState = original;
    expect(response.body as ActivityStateResponse).toEqual(dstState);
  });

  it("creates, lists, edits, and archives named schedules", async () => {
    const create = await request(server).post(`/api/pets/${PET}/treatment-schedules`).set("authorization", "Bearer valid")
      .send({ kind: "medicine", name: "  Heart tablet  ", timezone: "Asia/Jakarta", dailyTimes: ["20:00", "08:00"] });
    const list = await request(server).get(`/api/pets/${PET}/treatment-schedules`).set("authorization", "Bearer valid");
    const update = await request(server).patch(`/api/pets/${PET}/treatment-schedules/${SCHEDULE}`).set("authorization", "Bearer valid")
      .send({ name: "New name" });
    const archive = await request(server).delete(`/api/pets/${PET}/treatment-schedules/${SCHEDULE}`).set("authorization", "Bearer valid");
    expect(create.status).toBe(201); expect(list.status).toBe(200); expect(update.status).toBe(200); expect(archive.status).toBe(204);
    expect(updateCall).toEqual({ scheduleId: SCHEDULE, input: { name: "New name" } }); expect(archivedSchedule).toBe(SCHEDULE);
  });

  it("validates patches and maps schedule limit/cross-pair denials", async () => {
    const empty = await request(server).patch(`/api/pets/${PET}/treatment-schedules/${SCHEDULE}`)
      .set("authorization", "Bearer valid").send({});
    expect(empty.status).toBe(400);
    for (const [code, status] of [["TREATMENT_SCHEDULE_LIMIT_REACHED", 409], ["PET_NOT_FOUND", 404]] as const) {
      nextError = code;
      const response = await request(server).post(`/api/pets/${PET}/treatment-schedules`).set("authorization", "Bearer other")
        .send({ kind: "ointment", name: "Cream", timezone: "UTC", dailyTimes: ["08:00"] });
      expect(response.status).toBe(status); expect((response.body as ErrorBody).error.code).toBe(code);
    }
  });
});
