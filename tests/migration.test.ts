import { describe, expect, it } from "bun:test";

const migrationPath = `${process.cwd()}/supabase/migrations/20260825220300_care_activity.sql`;

describe("care migration structure", () => {
  it("checks raw feed and treatment slots before advancing read hints", async () => {
    const sql = await Bun.file(migrationPath).text();
    const rawTreatment = sql.indexOf("slot:=public.newest_actionable_schedule_slot(treatment.timezone");
    const treatmentHint = sql.indexOf("treatment_hint:=public.schedule_hint");
    const rawFeed = sql.indexOf("slot:=public.newest_actionable_schedule_slot(feeding.timezone");
    const feedHint = sql.indexOf("feed_hint:=public.feeding_hint");

    expect(rawTreatment).toBeGreaterThan(0);
    expect(rawTreatment).toBeLessThan(treatmentHint);
    expect(rawFeed).toBeGreaterThan(0);
    expect(rawFeed).toBeLessThan(feedHint);
    expect(sql).toContain("care_activities_feed_slot_key");
    expect(sql).toContain("message='SCHEDULE_SLOT_ALREADY_COMPLETED'");
  });

  it("keeps exact replay responses private and leaves virtual stats unstored", async () => {
    const sql = await Bun.file(migrationPath).text();

    expect(sql).toContain("care_idempotency_results");
    expect(sql).toContain("return replay.response_body");
    expect(sql).toContain("alter table public.care_idempotency_results enable row level security");
    expect(sql).not.toMatch(/current_(?:hunger|energy|mood|affection)/i);
  });
});

describe("notification migration structure", () => {
  it("enforces device reassignment, actor exclusion, delivery uniqueness, and terminal failures", async () => {
    const sql = await Bun.file(`${process.cwd()}/supabase/migrations/20260828220600_activity_notifications.sql`).text();
    expect(sql).toContain("push_tokens_active_device_key");
    expect(sql).toContain("membership.user_id<>activity.actor_user_id");
    expect(sql).toContain("primary key (outbox_id, push_token_id)");
    expect(sql).toContain("requested_final then 'dead'");
  });

  it("uses deterministic claim generations and keeps transient failures leased to BullMQ", async () => {
    const sql = await Bun.file(`${process.cwd()}/supabase/migrations/20260828220600_activity_notifications.sql`).text();

    expect(sql).toContain("jsonb_build_object('outboxId',id,'generation',attempts)");
    expect(sql).toContain("status='processing' and locked_at<statement_timestamp()-interval '10 minutes'");
    expect(sql).toContain("requested_final then 'dead' else 'processing'");
  });
});

describe("Web Push migration structure", () => {
  it("enforces global device ownership, actor exclusion, and per-subscription idempotency", async () => {
    const sql = await Bun.file(`${process.cwd()}/supabase/migrations/20260828231500_web_push_notifications.sql`).text();
    expect(sql).toContain("web_push_subscriptions_active_device_key");
    expect(sql).toContain("membership.user_id<>activity.actor_user_id");
    expect(sql).toContain("primary key (outbox_id, web_push_subscription_id)");
    expect(sql).toContain("where user_id=requested_user_id and device_id=btrim(requested_device_id) and active");
  });

  it("terminalizes inactive and expired Web Push attempts before combined finalization", async () => {
    const sql = await Bun.file(`${process.cwd()}/supabase/migrations/20260828231500_web_push_notifications.sql`).text();
    expect(sql).toContain("last_error_code='TOKEN_INACTIVE'");
    expect(sql).toContain("last_error_code='SUBSCRIPTION_INACTIVE'");
    expect(sql).toContain("subscription.expiration_time<=statement_timestamp()");
    expect(sql).toContain("select status from public.web_push_delivery_attempts");
    expect(sql).toContain("last_error_code='MAX_ATTEMPTS'");
    expect(sql).toContain("requested_final or attempt_count>=5");
  });
});

describe("instant Web Push migration structure", () => {
  it("claims each activity once for its actor and targets only the partner", async () => {
    const sql = await Bun.file(`${process.cwd()}/supabase/migrations/20261007120000_instant_web_push.sql`).text();
    expect(sql).toContain("outbox.actor_user_id=requested_user_id");
    expect(sql).toContain("outbox.status='pending'");
    expect(sql).toContain("membership.user_id<>requested_user_id");
    expect(sql).toContain("membership.pair_id=outbox.pair_id and membership.user_id=requested_user_id");
    expect(sql).toContain("to service_role");
  });

  it("retires the worker and Expo tables and helpers", async () => {
    const sql = await Bun.file(`${process.cwd()}/supabase/migrations/20261007120000_instant_web_push.sql`).text();
    for (const table of ["web_push_delivery_attempts", "notification_delivery_attempts", "push_tokens"]) {
      expect(sql).toContain(`drop table if exists public.${table}`);
    }
    expect(sql).toContain("drop function if exists public.claim_notification_outbox(text,integer)");
    expect(sql).toContain("drop function if exists public.register_push_token(uuid,text,text)");
  });
});
