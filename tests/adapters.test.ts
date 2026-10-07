import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAuthVerifier } from "@/auth/supabaseAuthVerifier";
import { createPairingQueries, PairingQueryError } from "@/queries/pairing";
import type { Database, Json } from "@/types/database";
import { createLogger } from "@/utils/logger";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PAIR_ID = "22222222-2222-4222-8222-222222222222";
const PET_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_AT = "2026-08-25T00:00:00.000Z";

describe("Supabase adapters", () => {
  it("verifies the bearer token through Supabase Auth", async () => {
    const receivedTokens: string[] = [];
    const client = {
      auth: {
        getUser(token: string) {
          receivedTokens.push(token);
          return Promise.resolve({
            data: { user: { id: USER_ID } },
            error: null,
          });
        },
      },
    } as unknown as SupabaseClient<Database>;

    const result = await createSupabaseAuthVerifier(client).verifyAccessToken("jwt-token");

    expect(receivedTokens).toEqual(["jwt-token"]);
    expect(result).toEqual({ id: USER_ID });
  });

  it("calls workspace RPC with only the verified user id", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const response: Json = {
      user: { id: USER_ID, displayName: null },
      pair: null,
      pet: null,
      membership: null,
    };
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: response, error: null });
      },
    } as unknown as SupabaseClient<Database>;

    const result = await createPairingQueries(client).getWorkspace(USER_ID);

    expect(calls).toEqual([
      { name: "get_my_workspace", args: { requested_user_id: USER_ID } },
    ]);
    expect(result.pair).toBeNull();
  });

  it("calls the atomic join RPC with user id and hash only", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const response: Json = {
      pair: { id: PAIR_ID, createdAt: CREATED_AT, memberCount: 2 },
      pet: { id: PET_ID, name: "Mochi", createdAt: CREATED_AT },
      membership: {
        pairId: PAIR_ID,
        userId: USER_ID,
        role: "member",
        joinedAt: CREATED_AT,
      },
    };
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: response, error: null });
      },
    } as unknown as SupabaseClient<Database>;

    await createPairingQueries(client).joinPair(USER_ID, "a".repeat(64));

    expect(calls).toEqual([{
      name: "join_pair_by_invite",
      args: {
        requested_user_id: USER_ID,
        requested_invite_hash: "a".repeat(64),
      },
    }]);
  });

  it("converts known RPC failures without exposing unknown database messages", async () => {
    const knownClient = {
      rpc() {
        return Promise.resolve({
          data: null,
          error: { message: "PAIR_FULL" },
        });
      },
    } as unknown as SupabaseClient<Database>;
    const unknownClient = {
      rpc() {
        return Promise.resolve({
          data: null,
          error: { message: "secret database detail" },
        });
      },
    } as unknown as SupabaseClient<Database>;

    let knownError: unknown;
    let unknownError: unknown;
    try {
      await createPairingQueries(knownClient).joinPair(USER_ID, "a".repeat(64));
    } catch (error) {
      knownError = error;
    }
    try {
      await createPairingQueries(unknownClient).joinPair(USER_ID, "a".repeat(64));
    } catch (error) {
      unknownError = error;
    }

    expect(knownError).toBeInstanceOf(PairingQueryError);
    expect(unknownError).toMatchObject({ message: "Pairing database operation failed" });
  });
});

describe("secret redaction", () => {
  it("redacts credentials and invite material from structured logs", () => {
    const chunks: string[] = [];
    const logger = createLogger(
      {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
      },
      { write: (chunk) => { chunks.push(chunk); } },
    );

    logger.info({
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      inviteCode: "ABC234",
      inviteHash: "a".repeat(64),
      invite: { code: "ABC234" },
      label: "Private treatment",
      note: "Private note",
      VAPID_PRIVATE_KEY: "vapid-private-secret",
      endpoint: "https://push.example/subscription-secret",
      subscription: { keys: { p256dh: "private-p256dh", auth: "private-auth" } },
    }, "redaction check");

    const output = chunks.join("");
    expect(output).not.toContain("service-role-secret");
    expect(output).not.toContain("ABC234");
    expect(output).not.toContain("a".repeat(64));
    expect(output).not.toContain("Private treatment");
    expect(output).not.toContain("Private note");
    expect(output).not.toContain("vapid-private-secret");
    expect(output).not.toContain("subscription-secret");
    expect(output).not.toContain("private-p256dh");
    expect(output).not.toContain("private-auth");
    expect(output).toContain("[REDACTED]");
  });
});
