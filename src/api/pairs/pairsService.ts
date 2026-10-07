import { createHash, randomInt } from "node:crypto";

import {
  PairingQueryError,
  type PairingQueries,
} from "@/queries/pairing";
import type {
  CreatePairResponse,
  JoinPairResponse,
  RotateInviteResponse,
} from "@/types/api";
import { ApiError } from "@/utils/errors";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_LENGTH = 6;

export interface InviteCodeGenerator {
  generate(): string;
}

const secureInviteCodeGenerator: InviteCodeGenerator = {
  generate() {
    return Array.from(
      { length: INVITE_LENGTH },
      () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)] ?? "A",
    ).join("");
  },
};

export function hashInviteCode(inviteCode: string): string {
  return createHash("sha256").update(inviteCode.toUpperCase()).digest("hex");
}

function mapPairingError(error: unknown): never {
  if (!(error instanceof PairingQueryError)) throw error;

  const errors: Record<string, { status: number; message: string }> = {
    AUTH_REQUIRED: { status: 401, message: "Authentication required" },
    INVITE_INVALID: { status: 404, message: "Invite code is invalid" },
    INVITE_EXPIRED: { status: 409, message: "Invite code has expired" },
    PAIR_FULL: { status: 409, message: "Pair already has two members" },
    USER_ALREADY_PAIRED: {
      status: 409,
      message: "User already belongs to a pair",
    },
    ALREADY_A_MEMBER: {
      status: 409,
      message: "User is already a member of this pair",
    },
    PAIR_NOT_FOUND: { status: 404, message: "Pair not found" },
    VALIDATION_ERROR: { status: 400, message: "Request validation failed" },
  };
  const mapped = errors[error.databaseCode];

  if (mapped === undefined) throw error;
  throw new ApiError(mapped.status, error.databaseCode, mapped.message);
}

export interface PairsService {
  createPair(userId: string, petName: string): Promise<CreatePairResponse>;
  joinPair(userId: string, inviteCode: string): Promise<JoinPairResponse>;
  rotateInvite(userId: string): Promise<RotateInviteResponse>;
}

export function createPairsService(
  queries: PairingQueries,
  codeGenerator: InviteCodeGenerator = secureInviteCodeGenerator,
): PairsService {
  return {
    async createPair(userId, petName) {
      const code = codeGenerator.generate();

      try {
        const { inviteExpiresAt, ...workspace } = await queries.createPair(
          userId,
          petName,
          hashInviteCode(code),
        );

        return {
          ...workspace,
          invite: { code, expiresAt: inviteExpiresAt },
        };
      } catch (error) {
        mapPairingError(error);
      }
    },

    async joinPair(userId, inviteCode) {
      try {
        return await queries.joinPair(userId, hashInviteCode(inviteCode));
      } catch (error) {
        mapPairingError(error);
      }
    },

    async rotateInvite(userId) {
      const code = codeGenerator.generate();

      try {
        const result = await queries.rotateInvite(userId, hashInviteCode(code));
        return { invite: { code, expiresAt: result.inviteExpiresAt } };
      } catch (error) {
        mapPairingError(error);
      }
    },
  };
}
