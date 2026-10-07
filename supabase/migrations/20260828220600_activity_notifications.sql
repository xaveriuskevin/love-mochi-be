-- Push registrations and durable per-device activity delivery state.

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null unique,
  platform text not null check (platform = 'ios'),
  device_id text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_reason text,
  constraint push_tokens_token_length check (char_length(token) between 1 and 4096),
  constraint push_tokens_device_id_length check (char_length(device_id) between 1 and 255),
  constraint push_tokens_active_consistency check (
    (active and disabled_at is null) or (not active and disabled_at is not null)
  )
);

drop index if exists public.push_tokens_active_user_device_key;
create unique index if not exists push_tokens_active_device_key
  on public.push_tokens (device_id) where active;
create index if not exists push_tokens_active_user_idx
  on public.push_tokens (user_id) where active;

create table if not exists public.notification_delivery_attempts (
  outbox_id uuid not null references public.notification_outbox (id) on delete cascade,
  push_token_id uuid not null references public.push_tokens (id) on delete cascade,
  status text not null default 'pending' check (
    status in ('pending', 'sending', 'ticketed', 'retry', 'delivered', 'invalid', 'failed')
  ),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  expo_ticket_id text,
  last_error_code text,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (outbox_id, push_token_id)
);

create index if not exists notification_delivery_receipts_idx
  on public.notification_delivery_attempts (outbox_id, status)
  where status = 'ticketed';

alter table public.notification_outbox
  add column if not exists locked_at timestamptz;
alter table public.notification_outbox
  add column if not exists worker_id text;
alter table public.notification_outbox
  drop constraint if exists notification_outbox_status_check;
alter table public.notification_outbox
  add constraint notification_outbox_status_check check (
    status in ('pending', 'processing', 'receipt_pending', 'delivered', 'failed', 'dead')
  );

create or replace function public.register_push_token(
  requested_user_id uuid, requested_token text, requested_device_id text
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
  if requested_token is null or char_length(requested_token) not between 1 and 4096
     or requested_device_id is null or char_length(btrim(requested_device_id)) not between 1 and 255 then
    raise exception using errcode='P0001',message='VALIDATION_ERROR';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('push-token:'||requested_token,0));
  perform pg_advisory_xact_lock(hashtextextended('push-device:'||requested_device_id,0));

  update public.push_tokens set active=false,disabled_at=statement_timestamp(),
    disabled_reason='replaced',updated_at=statement_timestamp()
  where device_id=requested_device_id and active;

  insert into public.push_tokens(user_id,token,platform,device_id)
  values(requested_user_id,requested_token,'ios',requested_device_id)
  on conflict(token) do update set user_id=excluded.user_id,device_id=excluded.device_id,
    platform='ios',active=true,disabled_at=null,disabled_reason=null,updated_at=statement_timestamp();
  return jsonb_build_object('registered',true);
end;
$$;

create or replace function public.remove_push_token(requested_user_id uuid, requested_device_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.push_tokens set active=false,disabled_at=statement_timestamp(),
    disabled_reason='removed',updated_at=statement_timestamp()
  where user_id=requested_user_id and device_id=requested_device_id and active;
end;
$$;

create or replace function public.claim_notification_outbox(requested_worker_id text, requested_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare ids jsonb;
begin
  if requested_limit not between 1 and 100 then
    raise exception using errcode='P0001',message='VALIDATION_ERROR';
  end if;
  with candidates as (
    select id from public.notification_outbox
    where ((status in ('pending','failed') and available_at<=statement_timestamp())
      or (status='processing' and locked_at<statement_timestamp()-interval '10 minutes'))
    order by available_at,created_at for update skip locked limit requested_limit
  ), claimed as (
    update public.notification_outbox outbox set status='processing',locked_at=statement_timestamp(),
      worker_id=requested_worker_id,attempts=outbox.attempts+1
    from candidates where outbox.id=candidates.id returning outbox.id,outbox.attempts
  ) select coalesce(jsonb_agg(jsonb_build_object('outboxId',id,'generation',attempts)),'[]'::jsonb)
    into ids from claimed;
  return ids;
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

  with eligible as (
    select attempt.push_token_id from public.notification_delivery_attempts attempt
    join public.push_tokens token on token.id=attempt.push_token_id
    where attempt.outbox_id=requested_outbox_id and token.active
      and attempt.attempt_count<5
      and (attempt.status in ('pending','retry')
        or (attempt.status='sending' and attempt.locked_at<statement_timestamp()-interval '5 minutes'))
      and attempt.next_attempt_at<=statement_timestamp()
    for update of attempt skip locked
  ), locked as (
    update public.notification_delivery_attempts attempt set status='sending',
      attempt_count=attempt.attempt_count+1,locked_at=statement_timestamp(),updated_at=statement_timestamp()
    from eligible where attempt.outbox_id=requested_outbox_id
      and attempt.push_token_id=eligible.push_token_id
    returning attempt.push_token_id,attempt.attempt_count
  )
  select jsonb_build_object(
    'outboxId',requested_outbox_id,'activityId',activity.id,'petId',activity.pet_id,
    'actorDisplayName',activity.actor_display_name,'petName',pet.name,
    'type',activity.type,'phase',activity.phase,
    'devices',coalesce(jsonb_agg(jsonb_build_object(
      'pushTokenId',locked.push_token_id,'token',token.token,'attemptCount',locked.attempt_count
    )) filter(where locked.push_token_id is not null),'[]'::jsonb)
  ) into result
  from public.pets pet
  left join locked on true left join public.push_tokens token on token.id=locked.push_token_id
  where pet.id=activity.pet_id group by pet.name;
  return result;
end;
$$;

create or replace function public.record_notification_ticket(
  requested_outbox_id uuid,requested_push_token_id uuid,requested_status text,
  requested_ticket_id text,requested_error_code text
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if requested_status not in ('ticketed','retry','invalid','failed') then
    raise exception using errcode='P0001',message='VALIDATION_ERROR'; end if;
  update public.notification_delivery_attempts set status=requested_status,
    expo_ticket_id=requested_ticket_id,last_error_code=requested_error_code,
    next_attempt_at=case when requested_status='retry' then statement_timestamp() else next_attempt_at end,
    updated_at=statement_timestamp(),locked_at=null
  where outbox_id=requested_outbox_id and push_token_id=requested_push_token_id and status='sending';
  if requested_status='invalid' then
    update public.push_tokens set active=false,disabled_at=statement_timestamp(),
      disabled_reason='DeviceNotRegistered',updated_at=statement_timestamp()
    where id=requested_push_token_id;
  end if;
end; $$;

create or replace function public.list_notification_receipts(requested_outbox_id uuid)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('pushTokenId',push_token_id,'ticketId',expo_ticket_id)),'[]'::jsonb)
  from public.notification_delivery_attempts where outbox_id=requested_outbox_id and status='ticketed';
$$;

create or replace function public.record_notification_receipt(
  requested_outbox_id uuid,requested_push_token_id uuid,requested_status text,requested_error_code text
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if requested_status not in ('delivered','retry','invalid','failed') then
    raise exception using errcode='P0001',message='VALIDATION_ERROR'; end if;
  update public.notification_delivery_attempts set status=requested_status,last_error_code=requested_error_code,
    delivered_at=case when requested_status='delivered' then statement_timestamp() else delivered_at end,
    next_attempt_at=case when requested_status='retry' then statement_timestamp() else next_attempt_at end,
    updated_at=statement_timestamp() where outbox_id=requested_outbox_id and push_token_id=requested_push_token_id
      and status='ticketed';
  if requested_status='invalid' then
    update public.push_tokens set active=false,disabled_at=statement_timestamp(),
      disabled_reason='DeviceNotRegistered',updated_at=statement_timestamp()
    where id=requested_push_token_id;
  end if;
end; $$;

create or replace function public.mark_notification_provider_failure(
  requested_outbox_id uuid,requested_final boolean,requested_error_code text
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.notification_delivery_attempts set status=case when requested_final then 'failed' else 'retry' end,
    last_error_code=requested_error_code,locked_at=null,next_attempt_at=statement_timestamp(),updated_at=statement_timestamp()
  where outbox_id=requested_outbox_id and status='sending';
  update public.notification_outbox set status=case when requested_final then 'dead' else 'processing' end,
    available_at=statement_timestamp(),locked_at=case when requested_final then null else statement_timestamp() end,
    processed_at=case when requested_final then statement_timestamp() else null end
  where id=requested_outbox_id;
end; $$;

create or replace function public.finalize_notification_outbox(requested_outbox_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare pending_count integer; ticket_count integer; failed_count integer;
begin
  select count(*) filter(where status in ('pending','sending','retry')),
    count(*) filter(where status='ticketed'),count(*) filter(where status='failed')
    into pending_count,ticket_count,failed_count
  from public.notification_delivery_attempts where outbox_id=requested_outbox_id;
  update public.notification_outbox set
    status=case when pending_count>0 then 'processing' when ticket_count>0 then 'receipt_pending'
      when failed_count>0 then 'dead' else 'delivered' end,
    available_at=case when pending_count>0 then statement_timestamp() else available_at end,
    processed_at=case when pending_count=0 and ticket_count=0 then statement_timestamp() else null end,
    locked_at=case when pending_count>0 then statement_timestamp() else null end
    where id=requested_outbox_id;
  return jsonb_build_object('hasPending',pending_count>0,'hasReceipts',ticket_count>0);
end; $$;

alter table public.push_tokens enable row level security;
alter table public.notification_delivery_attempts enable row level security;
-- Both tables are backend/worker-only; clients receive no direct policies.
revoke all on public.push_tokens,public.notification_delivery_attempts from anon,authenticated;

revoke all on function public.register_push_token(uuid,text,text),public.remove_push_token(uuid,text),
  public.claim_notification_outbox(text,integer),public.prepare_notification_delivery(uuid),
  public.record_notification_ticket(uuid,uuid,text,text,text),public.list_notification_receipts(uuid),
  public.record_notification_receipt(uuid,uuid,text,text),public.mark_notification_provider_failure(uuid,boolean,text),
  public.finalize_notification_outbox(uuid) from public,anon,authenticated;
grant execute on function public.register_push_token(uuid,text,text),public.remove_push_token(uuid,text),
  public.claim_notification_outbox(text,integer),public.prepare_notification_delivery(uuid),
  public.record_notification_ticket(uuid,uuid,text,text,text),public.list_notification_receipts(uuid),
  public.record_notification_receipt(uuid,uuid,text,text),public.mark_notification_provider_failure(uuid,boolean,text),
  public.finalize_notification_outbox(uuid) to service_role;
