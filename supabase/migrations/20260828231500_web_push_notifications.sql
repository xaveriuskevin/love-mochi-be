-- Standards-based Web Push registrations and durable per-subscription delivery.

create table if not exists public.web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null,
  endpoint text not null unique,
  expiration_time timestamptz,
  p256dh text not null,
  auth_key text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_reason text,
  constraint web_push_endpoint_length check (char_length(endpoint) between 1 and 4096),
  constraint web_push_device_id_length check (char_length(device_id) between 1 and 255),
  constraint web_push_p256dh_length check (char_length(p256dh) between 1 and 4096),
  constraint web_push_auth_key_length check (char_length(auth_key) between 1 and 4096),
  constraint web_push_active_consistency check (
    (active and disabled_at is null) or (not active and disabled_at is not null)
  )
);

create unique index if not exists web_push_subscriptions_active_device_key
  on public.web_push_subscriptions (device_id) where active;
create index if not exists web_push_subscriptions_active_user_idx
  on public.web_push_subscriptions (user_id) where active;

create table if not exists public.web_push_delivery_attempts (
  outbox_id uuid not null references public.notification_outbox (id) on delete cascade,
  web_push_subscription_id uuid not null references public.web_push_subscriptions (id) on delete cascade,
  status text not null default 'pending' check (
    status in ('pending', 'sending', 'retry', 'delivered', 'invalid', 'failed')
  ),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  last_error_code text,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (outbox_id, web_push_subscription_id)
);

create or replace function public.register_web_push_subscription(
  requested_user_id uuid,
  requested_device_id text,
  requested_endpoint text,
  requested_expiration_time double precision,
  requested_p256dh text,
  requested_auth text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists(select 1 from auth.users where id=requested_user_id) then
    raise exception using errcode='P0001',message='AUTH_REQUIRED';
  end if;
  if requested_device_id is null or char_length(btrim(requested_device_id)) not between 1 and 255
     or requested_endpoint is null or char_length(requested_endpoint) not between 1 and 4096
     or requested_endpoint !~ '^https://'
     or requested_p256dh is null or char_length(requested_p256dh) not between 1 and 4096
     or requested_auth is null or char_length(requested_auth) not between 1 and 4096
     or (requested_expiration_time is not null and requested_expiration_time <= 0) then
    raise exception using errcode='P0001',message='VALIDATION_ERROR';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('web-push-registration',0));
  perform pg_advisory_xact_lock(hashtextextended('web-push-endpoint:'||requested_endpoint,0));
  perform pg_advisory_xact_lock(hashtextextended('web-push-device:'||btrim(requested_device_id),0));

  update public.web_push_subscriptions
  set active=false,disabled_at=statement_timestamp(),disabled_reason='replaced',
    updated_at=statement_timestamp()
  where device_id=btrim(requested_device_id) and active;

  insert into public.web_push_subscriptions(
    user_id,device_id,endpoint,expiration_time,p256dh,auth_key
  ) values (
    requested_user_id,btrim(requested_device_id),requested_endpoint,
    case when requested_expiration_time is null then null
      else to_timestamp(requested_expiration_time / 1000.0) end,
    requested_p256dh,requested_auth
  )
  on conflict(endpoint) do update set
    user_id=excluded.user_id,device_id=excluded.device_id,
    expiration_time=excluded.expiration_time,p256dh=excluded.p256dh,auth_key=excluded.auth_key,
    active=true,disabled_at=null,disabled_reason=null,updated_at=statement_timestamp();

  return jsonb_build_object('registered',true);
end;
$$;

create or replace function public.remove_web_push_subscription(
  requested_user_id uuid, requested_device_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('web-push-registration',0));
  update public.web_push_subscriptions
  set active=false,disabled_at=statement_timestamp(),disabled_reason='removed',
    updated_at=statement_timestamp()
  where user_id=requested_user_id and device_id=btrim(requested_device_id) and active;
end;
$$;

create or replace function public.prepare_notification_delivery(requested_outbox_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare result jsonb; activity public.care_activities%rowtype;
begin
  perform 1 from public.notification_outbox where id=requested_outbox_id for update;
  if not found then raise exception using errcode='P0001',message='OUTBOX_NOT_FOUND'; end if;
  update public.notification_outbox set status='processing',locked_at=statement_timestamp()
    where id=requested_outbox_id;
  select care.* into activity from public.notification_outbox outbox
    join public.care_activities care on care.id=outbox.activity_id where outbox.id=requested_outbox_id;

  insert into public.notification_delivery_attempts(outbox_id,push_token_id)
  select requested_outbox_id,token.id from public.pair_memberships membership
    join public.push_tokens token on token.user_id=membership.user_id and token.active
  where membership.pair_id=activity.pair_id and membership.user_id<>activity.actor_user_id
  on conflict(outbox_id,push_token_id) do nothing;

  update public.web_push_subscriptions
  set active=false,disabled_at=statement_timestamp(),disabled_reason='expired',
    updated_at=statement_timestamp()
  where active and expiration_time is not null and expiration_time<=statement_timestamp();

  insert into public.web_push_delivery_attempts(outbox_id,web_push_subscription_id)
  select requested_outbox_id,subscription.id from public.pair_memberships membership
    join public.web_push_subscriptions subscription
      on subscription.user_id=membership.user_id and subscription.active
      and (subscription.expiration_time is null or subscription.expiration_time>statement_timestamp())
  where membership.pair_id=activity.pair_id and membership.user_id<>activity.actor_user_id
  on conflict(outbox_id,web_push_subscription_id) do nothing;

  -- A registration can be removed, replaced, disabled, or expire after its
  -- durable attempt was created. Terminalize those attempts so they cannot
  -- keep the combined outbox in processing forever.
  update public.notification_delivery_attempts attempt
  set status='invalid',last_error_code='TOKEN_INACTIVE',locked_at=null,
    updated_at=statement_timestamp()
  from public.push_tokens token
  where attempt.outbox_id=requested_outbox_id and token.id=attempt.push_token_id
    and not token.active and attempt.status in ('pending','sending','retry');

  update public.notification_delivery_attempts
  set status='failed',last_error_code='MAX_ATTEMPTS',locked_at=null,
    updated_at=statement_timestamp()
  where outbox_id=requested_outbox_id and attempt_count>=5
    and (status in ('pending','retry')
      or (status='sending' and locked_at<statement_timestamp()-interval '5 minutes'));

  update public.web_push_delivery_attempts attempt
  set status='invalid',last_error_code='SUBSCRIPTION_INACTIVE',locked_at=null,
    updated_at=statement_timestamp()
  from public.web_push_subscriptions subscription
  where attempt.outbox_id=requested_outbox_id
    and subscription.id=attempt.web_push_subscription_id
    and (not subscription.active or
      (subscription.expiration_time is not null and subscription.expiration_time<=statement_timestamp()))
    and attempt.status in ('pending','sending','retry');

  update public.web_push_delivery_attempts
  set status='failed',last_error_code='MAX_ATTEMPTS',locked_at=null,
    updated_at=statement_timestamp()
  where outbox_id=requested_outbox_id and attempt_count>=5
    and (status in ('pending','retry')
      or (status='sending' and locked_at<statement_timestamp()-interval '5 minutes'));

  with device_eligible as (
    select attempt.push_token_id from public.notification_delivery_attempts attempt
    join public.push_tokens token on token.id=attempt.push_token_id
    where attempt.outbox_id=requested_outbox_id and token.active
      and attempt.attempt_count<5
      and (attempt.status in ('pending','retry')
        or (attempt.status='sending' and attempt.locked_at<statement_timestamp()-interval '5 minutes'))
      and attempt.next_attempt_at<=statement_timestamp()
    for update of attempt skip locked
  ), device_locked as (
    update public.notification_delivery_attempts attempt set status='sending',
      attempt_count=attempt.attempt_count+1,locked_at=statement_timestamp(),updated_at=statement_timestamp()
    from device_eligible where attempt.outbox_id=requested_outbox_id
      and attempt.push_token_id=device_eligible.push_token_id
    returning attempt.push_token_id,attempt.attempt_count
  ), web_eligible as (
    select attempt.web_push_subscription_id from public.web_push_delivery_attempts attempt
    join public.web_push_subscriptions subscription on subscription.id=attempt.web_push_subscription_id
    where attempt.outbox_id=requested_outbox_id and subscription.active
      and (subscription.expiration_time is null or subscription.expiration_time>statement_timestamp())
      and attempt.attempt_count<5
      and (attempt.status in ('pending','retry')
        or (attempt.status='sending' and attempt.locked_at<statement_timestamp()-interval '5 minutes'))
      and attempt.next_attempt_at<=statement_timestamp()
    for update of attempt skip locked
  ), web_locked as (
    update public.web_push_delivery_attempts attempt set status='sending',
      attempt_count=attempt.attempt_count+1,locked_at=statement_timestamp(),updated_at=statement_timestamp()
    from web_eligible where attempt.outbox_id=requested_outbox_id
      and attempt.web_push_subscription_id=web_eligible.web_push_subscription_id
    returning attempt.web_push_subscription_id,attempt.attempt_count
  )
  select jsonb_build_object(
    'outboxId',requested_outbox_id,'activityId',activity.id,'petId',activity.pet_id,
    'actorDisplayName',activity.actor_display_name,'petName',pet.name,
    'type',activity.type,'phase',activity.phase,
    'devices',coalesce((select jsonb_agg(jsonb_build_object(
      'pushTokenId',locked.push_token_id,'token',token.token,'attemptCount',locked.attempt_count
    )) from device_locked locked join public.push_tokens token on token.id=locked.push_token_id),'[]'::jsonb),
    'webSubscriptions',coalesce((select jsonb_agg(jsonb_build_object(
      'webPushSubscriptionId',locked.web_push_subscription_id,
      'endpoint',subscription.endpoint,'expirationTime',
        case when subscription.expiration_time is null then null
          else extract(epoch from subscription.expiration_time)*1000 end,
      'keys',jsonb_build_object('p256dh',subscription.p256dh,'auth',subscription.auth_key),
      'attemptCount',locked.attempt_count
    )) from web_locked locked join public.web_push_subscriptions subscription
      on subscription.id=locked.web_push_subscription_id),'[]'::jsonb)
  ) into result from public.pets pet where pet.id=activity.pet_id;
  return result;
end;
$$;

create or replace function public.record_web_push_delivery(
  requested_outbox_id uuid,requested_web_push_subscription_id uuid,
  requested_status text,requested_error_code text
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if requested_status not in ('delivered','retry','invalid','failed') then
    raise exception using errcode='P0001',message='VALIDATION_ERROR'; end if;
  update public.web_push_delivery_attempts set status=requested_status,
    last_error_code=requested_error_code,locked_at=null,
    delivered_at=case when requested_status='delivered' then statement_timestamp() else delivered_at end,
    next_attempt_at=case when requested_status='retry' then statement_timestamp() else next_attempt_at end,
    updated_at=statement_timestamp()
  where outbox_id=requested_outbox_id
    and web_push_subscription_id=requested_web_push_subscription_id and status='sending';
  if requested_status='invalid' then
    update public.web_push_subscriptions
    set active=false,disabled_at=statement_timestamp(),disabled_reason=coalesce(requested_error_code,'expired'),
      updated_at=statement_timestamp()
    where id=requested_web_push_subscription_id;
  end if;
end; $$;

create or replace function public.mark_notification_provider_failure(
  requested_outbox_id uuid,requested_final boolean,requested_error_code text
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.notification_delivery_attempts
  set status=case when requested_final or attempt_count>=5 then 'failed' else 'retry' end,
    last_error_code=requested_error_code,locked_at=null,next_attempt_at=statement_timestamp(),
    updated_at=statement_timestamp()
  where outbox_id=requested_outbox_id and status='sending';
  update public.notification_outbox
  set status='processing',available_at=statement_timestamp(),locked_at=statement_timestamp(),processed_at=null
  where id=requested_outbox_id;
end; $$;

create or replace function public.mark_web_push_provider_failure(
  requested_outbox_id uuid,requested_final boolean,requested_error_code text
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.web_push_delivery_attempts
  set status=case when requested_final or attempt_count>=5 then 'failed' else 'retry' end,
    last_error_code=requested_error_code,locked_at=null,next_attempt_at=statement_timestamp(),
    updated_at=statement_timestamp()
  where outbox_id=requested_outbox_id and status='sending';
  update public.notification_outbox
  set status='processing',available_at=statement_timestamp(),locked_at=statement_timestamp(),processed_at=null
  where id=requested_outbox_id;
end; $$;

create or replace function public.finalize_notification_outbox(requested_outbox_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare pending_count integer; ticket_count integer; failed_count integer;
begin
  select
    count(*) filter(where status in ('pending','sending','retry')),
    count(*) filter(where status='ticketed'),
    count(*) filter(where status='failed')
  into pending_count,ticket_count,failed_count
  from (
    select status from public.notification_delivery_attempts where outbox_id=requested_outbox_id
    union all
    select status from public.web_push_delivery_attempts where outbox_id=requested_outbox_id
  ) attempts;
  update public.notification_outbox set
    status=case when pending_count>0 then 'processing' when ticket_count>0 then 'receipt_pending'
      when failed_count>0 then 'dead' else 'delivered' end,
    available_at=case when pending_count>0 then statement_timestamp() else available_at end,
    processed_at=case when pending_count=0 and ticket_count=0 then statement_timestamp() else null end,
    locked_at=case when pending_count>0 then statement_timestamp() else null end
  where id=requested_outbox_id;
  return jsonb_build_object('hasPending',pending_count>0,'hasReceipts',ticket_count>0);
end; $$;

alter table public.web_push_subscriptions enable row level security;
alter table public.web_push_delivery_attempts enable row level security;
revoke all on public.web_push_subscriptions,public.web_push_delivery_attempts from public,anon,authenticated;

revoke all on function
  public.register_web_push_subscription(uuid,text,text,double precision,text,text),
  public.remove_web_push_subscription(uuid,text),
  public.record_web_push_delivery(uuid,uuid,text,text),
  public.mark_web_push_provider_failure(uuid,boolean,text),
  public.mark_notification_provider_failure(uuid,boolean,text)
from public,anon,authenticated;
grant execute on function
  public.register_web_push_subscription(uuid,text,text,double precision,text,text),
  public.remove_web_push_subscription(uuid,text),
  public.record_web_push_delivery(uuid,uuid,text,text),
  public.mark_web_push_provider_failure(uuid,boolean,text),
  public.mark_notification_provider_failure(uuid,boolean,text)
to service_role;

-- Replaced worker helpers must remain service-role only after CREATE OR REPLACE.
revoke all on function public.prepare_notification_delivery(uuid),public.finalize_notification_outbox(uuid)
from public,anon,authenticated;
grant execute on function public.prepare_notification_delivery(uuid),public.finalize_notification_outbox(uuid)
to service_role;
