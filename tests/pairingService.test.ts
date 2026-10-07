import { describe, expect, it } from "bun:test";

import {
  createPairsService,
  hashInviteCode,
} from "@/api/pairs/pairsService";
import {
  PairingQueryError,
  type PairingQueries,
} from "@/queries/pairing";
import type { PairWorkspace } from "@/types/api";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "44444444-4444-4444-8444-444444444444";
const EXPIRES_AT = "2026-08-28T00:00:00.000Z";
const workspace: PairWorkspace = {
  pair: {
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-08-25T00:00:00.000Z",
    memberCount: 2,
  },
  pet: {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Mochi",
    createdAt: "2026-08-25T00:00:00.000Z",
  },
  membership: {
    pairId: "22222222-2222-4222-8222-222222222222",
    userId: USER_A,
    role: "member",
    joinedAt: "2026-08-25T00:00:00.000Z",
  },
};

describe("pairs service", () => {
  it("passes hashes rather than plaintext to every invite RPC", async () => {
    const hashes: string[] = [];
    const queries: PairingQueries = {
      getWorkspace() { return Promise.reject(new Error("unused")); },
      createPair(_userId, _petName, hash) {
        hashes.push(hash);
        return Promise.resolve({ ...workspace, inviteExpiresAt: EXPIRES_AT });
      },
      joinPair(_userId, hash) {
        hashes.push(hash);
        return Promise.resolve(workspace);
      },
      rotateInvite(_userId, hash) {
        hashes.push(hash);
        return Promise.resolve({ inviteExpiresAt: EXPIRES_AT });
      },
    };
    const service = createPairsService(queries, { generate: () => "ABC234" });

    await service.createPair(USER_A, "Mochi");
    await service.joinPair(USER_B, "abc234");
    await service.rotateInvite(USER_A);

    expect(hashes).toEqual(Array<string>(3).fill(hashInviteCode("ABC234")));
    expect(hashes.join(" ")).not.toContain("ABC234");
  });

  it("surfaces exactly one winner in a mocked second-member race", async () => {
    let joined = false;
    const queries: PairingQueries = {
      getWorkspace() { return Promise.reject(new Error("unused")); },
      createPair() { return Promise.reject(new Error("unused")); },
      async joinPair(userId) {
        await Promise.resolve();
        if (joined) throw new PairingQueryError("PAIR_FULL");
        joined = true;
        return {
          ...workspace,
          membership: { ...workspace.membership, userId },
        };
      },
      rotateInvite() { return Promise.reject(new Error("unused")); },
    };
    const service = createPairsService(queries);
    const results = await Promise.allSettled([
      service.joinPair(USER_A, "ABC234"),
      service.joinPair(USER_B, "ABC234"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      const reason: unknown = rejected.reason;
      expect(reason).toMatchObject({ code: "PAIR_FULL", statusCode: 409 });
    }
  });
});
