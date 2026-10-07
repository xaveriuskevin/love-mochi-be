import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { CareQueryError, createCareQueries } from "@/queries/care";
import type { Database, Json } from "@/types/database";

const USER = "11111111-1111-4111-8111-111111111111";
const PET = "33333333-3333-4333-8333-333333333333";
const ACTIVITY = "77777777-7777-4777-8777-777777777777";
const OCCURRED = "2026-08-25T00:00:00.000Z";

const activity: Json = {
  id: ACTIVITY, petId: PET, actorUserId: USER, actorDisplayName: null,
  type: "feed", phase: null, label: null, note: null,
  treatmentScheduleId: null, scheduledFor: null, occurredAt: OCCURRED,
  idempotencyKey: "tap-1",
};

describe("care query adapter", () => {
  it("encodes an opaque stable cursor and decodes it into the next RPC", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let page = 0;
    const client = {
      rpc(_name: string, args: Record<string, unknown>) {
        calls.push(args); page += 1;
        return Promise.resolve({
          data: {
            items: [activity],
            nextCursorOccurredAt: page === 1 ? OCCURRED : null,
            nextCursorId: page === 1 ? ACTIVITY : null,
          },
          error: null,
        });
      },
    } as unknown as SupabaseClient<Database>;
    const queries = createCareQueries(client);

    const first = await queries.listActivities(USER, PET, 20, null);
    expect(first.nextCursor).toBeString();
    await queries.listActivities(USER, PET, 20, first.nextCursor);

    expect(calls[0]).toMatchObject({ requested_user_id: USER, requested_pet_id: PET, cursor_id: null });
    expect(calls[1]).toMatchObject({ cursor_occurred_at: OCCURRED, cursor_id: ACTIVITY });
  });

  it("rejects a malformed cursor before making an RPC", async () => {
    const client = { rpc: () => Promise.reject(new Error("must not run")) } as unknown as SupabaseClient<Database>;
    let captured: unknown;
    try { await createCareQueries(client).listActivities(USER, PET, 20, "not-a-cursor"); }
    catch (error) { captured = error; }
    expect(captured).toBeInstanceOf(CareQueryError);
    expect(captured).toMatchObject({ databaseCode: "VALIDATION_ERROR" });
  });
});
