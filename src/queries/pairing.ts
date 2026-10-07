import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { PairWorkspace, WorkspaceResponse } from "@/types/api";
import type { Database } from "@/types/database";

const userSummarySchema = z.object({
  id: z.uuid(),
  displayName: z.string().nullable(),
});

const pairSummarySchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  memberCount: z.union([z.literal(1), z.literal(2)]),
});

const petSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});

const membershipSchema = z.object({
  pairId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(["creator", "member"]),
  joinedAt: z.iso.datetime({ offset: true }),
});

const workspaceSchema = z.object({
  user: userSummarySchema,
  pair: pairSummarySchema.nullable(),
  pet: petSummarySchema.nullable(),
  membership: membershipSchema.nullable(),
});

const pairWorkspaceSchema = z.object({
  pair: pairSummarySchema,
  pet: petSummarySchema,
  membership: membershipSchema,
});

const createPairResultSchema = pairWorkspaceSchema.extend({
  inviteExpiresAt: z.iso.datetime({ offset: true }),
});

const rotateInviteResultSchema = z.object({
  inviteExpiresAt: z.iso.datetime({ offset: true }),
});

export type CreatePairDatabaseResult = PairWorkspace & {
  inviteExpiresAt: string;
};

export type RotateInviteDatabaseResult = {
  inviteExpiresAt: string;
};

export interface PairingQueries {
  getWorkspace(userId: string): Promise<WorkspaceResponse>;
  createPair(
    userId: string,
    petName: string,
    inviteHash: string,
  ): Promise<CreatePairDatabaseResult>;
  joinPair(userId: string, inviteHash: string): Promise<PairWorkspace>;
  rotateInvite(
    userId: string,
    inviteHash: string,
  ): Promise<RotateInviteDatabaseResult>;
}

export class PairingQueryError extends Error {
  public constructor(public readonly databaseCode: string) {
    super(databaseCode);
    this.name = "PairingQueryError";
  }
}

const DATABASE_ERROR_CODES = new Set([
  "AUTH_REQUIRED",
  "INVITE_INVALID",
  "INVITE_EXPIRED",
  "PAIR_FULL",
  "USER_ALREADY_PAIRED",
  "ALREADY_A_MEMBER",
  "PAIR_NOT_FOUND",
  "VALIDATION_ERROR",
]);

function throwRpcError(error: { message: string }): never {
  if (DATABASE_ERROR_CODES.has(error.message)) {
    throw new PairingQueryError(error.message);
  }

  throw new Error("Pairing database operation failed");
}

export function createPairingQueries(client: SupabaseClient<Database>): PairingQueries {
  return {
    async getWorkspace(userId) {
      const { data, error } = await client.rpc("get_my_workspace", {
        requested_user_id: userId,
      });

      if (error !== null) throwRpcError(error);
      return workspaceSchema.parse(data);
    },

    async createPair(userId, petName, inviteHash) {
      const { data, error } = await client.rpc("create_pair", {
        requested_user_id: userId,
        requested_pet_name: petName,
        requested_invite_hash: inviteHash,
      });

      if (error !== null) throwRpcError(error);
      return createPairResultSchema.parse(data);
    },

    async joinPair(userId, inviteHash) {
      const { data, error } = await client.rpc("join_pair_by_invite", {
        requested_user_id: userId,
        requested_invite_hash: inviteHash,
      });

      if (error !== null) throwRpcError(error);
      return pairWorkspaceSchema.parse(data);
    },

    async rotateInvite(userId, inviteHash) {
      const { data, error } = await client.rpc("rotate_pair_invite", {
        requested_user_id: userId,
        requested_invite_hash: inviteHash,
      });

      if (error !== null) throwRpcError(error);
      return rotateInviteResultSchema.parse(data);
    },
  };
}
