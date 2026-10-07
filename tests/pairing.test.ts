import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import pino from "pino";
import request from "supertest";

import { hashInviteCode } from "@/api/pairs/pairsService";
import type { AuthVerifier } from "@/middleware/auth";
import {
  PairingQueryError,
  type CreatePairDatabaseResult,
  type PairingQueries,
  type RotateInviteDatabaseResult,
} from "@/queries/pairing";
import { createApp } from "@/server";
import type { PairWorkspace, WorkspaceResponse } from "@/types/api";
import type {
  CreatePairResponse,
  JoinPairResponse,
  RotateInviteResponse,
} from "@/types/api";

type ErrorBody = {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
};

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PAIR_ID = "22222222-2222-4222-8222-222222222222";
const PET_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_AT = "2026-08-25T00:00:00.000Z";
const EXPIRES_AT = "2026-08-28T00:00:00.000Z";

const pairWorkspace: PairWorkspace = {
  pair: { id: PAIR_ID, createdAt: CREATED_AT, memberCount: 1 },
  pet: { id: PET_ID, name: "Mochi", createdAt: CREATED_AT },
  membership: {
    pairId: PAIR_ID,
    userId: USER_ID,
    role: "creator",
    joinedAt: CREATED_AT,
  },
};

const unpairedWorkspace: WorkspaceResponse = {
  user: { id: USER_ID, displayName: "Kevin" },
  pair: null,
  pet: null,
  membership: null,
};

let nextError: string | null = null;
let lastWorkspaceUserId: string | null = null;
let lastCreateCall: [string, string, string] | null = null;
let lastJoinCall: [string, string] | null = null;
let lastRotateCall: [string, string] | null = null;

function failIfConfigured(): void {
  if (nextError !== null) {
    const error = nextError;
    nextError = null;
    throw new PairingQueryError(error);
  }
}

const queries: PairingQueries = {
  getWorkspace(userId): Promise<WorkspaceResponse> {
    failIfConfigured();
    lastWorkspaceUserId = userId;
    return Promise.resolve(unpairedWorkspace);
  },
  createPair(userId, petName, inviteHash): Promise<CreatePairDatabaseResult> {
    failIfConfigured();
    lastCreateCall = [userId, petName, inviteHash];
    return Promise.resolve({ ...pairWorkspace, inviteExpiresAt: EXPIRES_AT });
  },
  joinPair(userId, inviteHash): Promise<PairWorkspace> {
    failIfConfigured();
    lastJoinCall = [userId, inviteHash];
    return Promise.resolve({
      ...pairWorkspace,
      pair: { ...pairWorkspace.pair, memberCount: 2 },
      membership: { ...pairWorkspace.membership, role: "member" },
    });
  },
  rotateInvite(userId, inviteHash): Promise<RotateInviteDatabaseResult> {
    failIfConfigured();
    lastRotateCall = [userId, inviteHash];
    return Promise.resolve({ inviteExpiresAt: EXPIRES_AT });
  },
};

const authVerifier: AuthVerifier = {
  verifyAccessToken(token) {
    return Promise.resolve(token === "valid-token" ? { id: USER_ID } : null);
  },
};

const app = createApp(pino({ enabled: false }), { authVerifier, pairingQueries: queries });
let server: Server;

beforeAll(async () => {
  server = app.listen(0);
  await once(server, "listening");
});

afterAll(() => {
  server.close();
});

describe("pairing and authentication API", () => {
  it("rejects missing and invalid bearer tokens with AUTH_REQUIRED", async () => {
    const missing = await request(server).get("/api/me/workspace");
    const invalid = await request(server)
      .get("/api/me/workspace")
      .set("authorization", "Bearer invalid-token");

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(missing.body as ErrorBody).toEqual({
      error: { code: "AUTH_REQUIRED", message: "Authentication required" },
    });
  });

  it("returns an unpaired workspace and derives identity only from auth", async () => {
    const response = await request(server)
      .get("/api/me/workspace")
      .query({ pair_id: "attacker-controlled" })
      .set("authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body as WorkspaceResponse).toEqual(unpairedWorkspace);
    expect(lastWorkspaceUserId).toBe(USER_ID);
  });

  it("creates a pair with a trimmed name and returns but never stores plaintext code", async () => {
    const response = await request(server)
      .post("/api/pairs")
      .set("authorization", "Bearer valid-token")
      .send({ petName: "  Mochi  " });

    expect(response.status).toBe(201);
    const body = response.body as CreatePairResponse;
    expect(body.pair).toEqual(pairWorkspace.pair);
    expect(body.invite.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(body.invite.expiresAt).toBe(EXPIRES_AT);
    expect(lastCreateCall?.[0]).toBe(USER_ID);
    expect(lastCreateCall?.[1]).toBe("Mochi");
    expect(lastCreateCall?.[2]).toBe(hashInviteCode(body.invite.code));
    expect(lastCreateCall?.[2]).not.toBe(body.invite.code);
  });

  it("returns contract validation fields and rejects client pair authority", async () => {
    const invalidName = await request(server)
      .post("/api/pairs")
      .set("authorization", "Bearer valid-token")
      .send({ petName: "   " });
    const suppliedPair = await request(server)
      .post("/api/pairs")
      .set("authorization", "Bearer valid-token")
      .send({ petName: "Mochi", pair_id: "attacker-controlled" });

    expect(invalidName.status).toBe(400);
    const invalidBody = invalidName.body as ErrorBody;
    expect(invalidBody.error.code).toBe("VALIDATION_ERROR");
    expect(invalidBody.error.fields?.petName).toBeString();
    expect(suppliedPair.status).toBe(400);
  });

  it("normalizes case and hashes invite codes before the atomic join RPC", async () => {
    const response = await request(server)
      .post("/api/pairs/join")
      .set("authorization", "Bearer valid-token")
      .send({ inviteCode: "abc234" });

    expect(response.status).toBe(200);
    expect((response.body as JoinPairResponse).pair.memberCount).toBe(2);
    expect(lastJoinCall).toEqual([USER_ID, hashInviteCode("ABC234")]);
  });

  it("rejects ambiguous, malformed, and extra join input", async () => {
    for (const body of [
      { inviteCode: "ABC01I" },
      { inviteCode: "SHORT" },
      { inviteCode: "ABC234", pairId: PAIR_ID },
    ]) {
      const response = await request(server)
        .post("/api/pairs/join")
        .set("authorization", "Bearer valid-token")
        .send(body);

      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("maps every documented join conflict from the transactional RPC", async () => {
    const cases = [
      ["INVITE_INVALID", 404],
      ["INVITE_EXPIRED", 409],
      ["PAIR_FULL", 409],
      ["USER_ALREADY_PAIRED", 409],
      ["ALREADY_A_MEMBER", 409],
    ] as const;

    for (const [code, status] of cases) {
      nextError = code;
      const response = await request(server)
        .post("/api/pairs/join")
        .set("authorization", "Bearer valid-token")
        .send({ inviteCode: "ABC234" });

      expect(response.status).toBe(status);
      expect((response.body as ErrorBody).error.code).toBe(code);
    }
  });

  it("maps create membership conflicts", async () => {
    nextError = "USER_ALREADY_PAIRED";
    const response = await request(server)
      .post("/api/pairs")
      .set("authorization", "Bearer valid-token")
      .send({ petName: "Mochi" });

    expect(response.status).toBe(409);
    expect((response.body as ErrorBody).error.code).toBe("USER_ALREADY_PAIRED");
  });

  it("rotates an invite without accepting a pair id", async () => {
    const response = await request(server)
      .post("/api/pairs/invite/rotate")
      .set("authorization", "Bearer valid-token")
      .send();

    expect(response.status).toBe(200);
    const body = response.body as RotateInviteResponse;
    expect(body.invite.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(lastRotateCall?.[0]).toBe(USER_ID);
    expect(lastRotateCall?.[1]).toBe(hashInviteCode(body.invite.code));

    const suppliedPair = await request(server)
      .post("/api/pairs/invite/rotate")
      .set("authorization", "Bearer valid-token")
      .send({ pairId: PAIR_ID });
    expect(suppliedPair.status).toBe(400);
  });

  it("maps rotate pair-not-found and pair-capacity errors", async () => {
    for (const [code, status] of [["PAIR_NOT_FOUND", 404], ["PAIR_FULL", 409]] as const) {
      nextError = code;
      const response = await request(server)
        .post("/api/pairs/invite/rotate")
        .set("authorization", "Bearer valid-token")
        .send();

      expect(response.status).toBe(status);
      expect((response.body as ErrorBody).error.code).toBe(code);
    }
  });
});
