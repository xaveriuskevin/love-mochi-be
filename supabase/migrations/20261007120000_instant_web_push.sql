-- Instant, best-effort Web Push sent by the API right after a care action.
-- Replaces the Expo + BullMQ worker pipeline: no queue, no retries.
--
-- notification_outbox stays: create_care_activity still writes exactly one row
-- per activity in the same transaction. The API claims that row once, so an
-- idempotent replay of the same request never notifies the partner twice.

create or replace function public.claim_care_notification(
  requested_user_id uuid, requested_activity_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare claimed public.notification_outbox%rowtype; activity public.care_activities%rowtype; result jsonb;
begin
  update public.notification_outbox outbox
  set status='delivered',attempts=outbox.attempts+1,processed_at=statement_timestamp()
  where outbox.activity_id=requested_activity_id and outbox.actor_user_id=requested_user_id
    and outbox.status='pending'
    and exists(select 1 from public.pair_memberships membership
      where membership.pair_id=outbox.pair_id and membership.user_id=requested_user_id)
  returning * into claimed;
  if not found then return null; end if;

  select * into activity from public.care_activities where id=claimed.activity_id;

  update public.web_push_subscriptions
  set active=false,disabled_at=statement_timestamp(),disabled_reason='expired',
    updated_at=statement_timestamp()
  where active and expiration_time is not null and expiration_time<=statement_timestamp();

  select jsonb_build_object(
    'activityId',activity.id,'petId',activity.pet_id,
    'actorDisplayName',activity.actor_display_name,'petName',pet.name,
    'type',activity.type,'phase',activity.phase,
    'webSubscriptions',coalesce((select jsonb_agg(jsonb_build_object(
      'webPushSubscriptionId',subscription.id,
      'endpoint',subscription.endpoint,'expirationTime',
        case when subscription.expiration_time is null then null
          else extract(epoch from subscription.expiration_time)*1000 end,
      'keys',jsonb_build_object('p256dh',subscription.p256dh,'auth',subscription.auth_key)
    )) from public.pair_memberships membership
      join public.web_push_subscriptions subscription
        on subscription.user_id=membership.user_id and subscription.active
    where membership.pair_id=claimed.pair_id and membership.user_id<>requested_user_id),'[]'::jsonb)
  ) into result from public.pets pet where pet.id=activity.pet_id;
  return result;
end;
$$;

create or replace function public.disable_web_push_subscription(
  requested_subscription_id uuid, requested_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if requested_reason is null or char_length(requested_reason) not between 1 and 64 then
    raise exception using errcode='P0001',message='VALIDATION_ERROR';
  end if;
  update public.web_push_subscriptions
  set active=false,disabled_at=statement_timestamp(),disabled_reason=requested_reason,
    updated_at=statement_timestamp()
  where id=requested_subscription_id and active;
end;
$$;

revoke all on function public.claim_care_notification(uuid,uuid),
  public.disable_web_push_subscription(uuid,text) from public,anon,authenticated;
grant execute on function public.claim_care_notification(uuid,uuid),
  public.disable_web_push_subscription(uuid,text) to service_role;

-- Retire the worker pipeline (outbox polling, per-attempt delivery, Expo).
drop function if exists public.claim_notification_outbox(text,integer);
drop function if exists public.prepare_notification_delivery(uuid);
drop function if exists public.record_web_push_delivery(uuid,uuid,text,text);
drop function if exists public.mark_web_push_provider_failure(uuid,boolean,text);
drop function if exists public.finalize_notification_outbox(uuid);
drop function if exists public.register_push_token(uuid,text,text);
drop function if exists public.remove_push_token(uuid,text);
drop function if exists public.record_notification_ticket(uuid,uuid,text,text,text);
drop function if exists public.list_notification_receipts(uuid);
drop function if exists public.record_notification_receipt(uuid,uuid,text,text);
drop function if exists public.mark_notification_provider_failure(uuid,boolean,text);

drop table if exists public.web_push_delivery_attempts;
drop table if exists public.notification_delivery_attempts;
drop table if exists public.push_tokens;
