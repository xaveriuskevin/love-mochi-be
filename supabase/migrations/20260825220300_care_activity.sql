-- Immutable real-pet care log. All status and schedule hints are derived from
-- events, schedules, and the database clock; no simulated pet stat is stored.

create unique index if not exists pets_id_pair_id_key on public.pets (id, pair_id);

create table if not exists public.feeding_schedules (
  pet_id uuid primary key references public.pets (id) on delete cascade,
  pair_id uuid not null references public.pairs (id) on delete cascade,
  timezone text not null,
  daily_times text[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feeding_schedules_daily_times_count
    check (cardinality(daily_times) between 1 and 8)
);

create table if not exists public.treatment_schedules (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets (id) on delete cascade,
  pair_id uuid not null references public.pairs (id) on delete cascade,
  kind text not null check (kind in ('medicine', 'ointment')),
  name text not null check (char_length(name) between 1 and 60 and name = btrim(name)),
  timezone text not null,
  daily_times text[] not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint treatment_schedules_daily_times_count
    check (cardinality(daily_times) between 1 and 8),
  constraint treatment_schedules_archive_consistency check (
    (active and archived_at is null) or (not active and archived_at is not null)
  )
);

create index if not exists treatment_schedules_pet_active_idx
  on public.treatment_schedules (pet_id, active);

create table if not exists public.care_activities (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets (id) on delete restrict,
  pair_id uuid not null references public.pairs (id) on delete restrict,
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  actor_display_name text,
  type text not null check (
    type in ('feed', 'poop', 'play', 'sleep', 'alone', 'custom', 'medicine', 'ointment')
  ),
  phase text check (phase in ('started', 'ended')),
  label text,
  note text,
  treatment_schedule_id uuid references public.treatment_schedules (id) on delete restrict,
  scheduled_for timestamptz,
  occurred_at timestamptz not null default statement_timestamp(),
  idempotency_key text not null,
  request_hash text not null,
  constraint care_activities_idempotency_key_length
    check (char_length(idempotency_key) between 1 and 128),
  constraint care_activities_idempotency_key_printable
    check (idempotency_key ~ '^[\x20-\x7e]+$'),
  constraint care_activities_request_hash_format check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint care_activities_label_length
    check (label is null or (char_length(label) between 1 and 60 and label = btrim(label))),
  constraint care_activities_note_length check (note is null or char_length(note) <= 500),
  constraint care_activities_shape check (
    (type in ('feed', 'poop', 'play') and phase is null and label is null and treatment_schedule_id is null)
    or (type in ('sleep', 'alone') and phase is not null and label is null and treatment_schedule_id is null and scheduled_for is null)
    or (type = 'custom' and phase is null and label is not null and treatment_schedule_id is null and scheduled_for is null)
    or (type in ('medicine', 'ointment') and phase is null and label is not null and treatment_schedule_id is not null and scheduled_for is not null)
  ),
  constraint care_activities_actor_idempotency unique (actor_user_id, idempotency_key)
);

create index if not exists care_activities_pet_history_idx
  on public.care_activities (pet_id, occurred_at desc, id desc);
create index if not exists care_activities_status_idx
  on public.care_activities (pet_id, type, occurred_at desc, id desc)
  where type in ('sleep', 'alone');
create index if not exists care_activities_feed_idx
  on public.care_activities (pet_id, occurred_at desc)
  where type = 'feed';
create unique index if not exists care_activities_treatment_slot_key
  on public.care_activities (treatment_schedule_id, scheduled_for)
  where treatment_schedule_id is not null;
create unique index if not exists care_activities_feed_slot_key
  on public.care_activities (pet_id, scheduled_for)
  where type = 'feed' and scheduled_for is not null;

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null unique references public.care_activities (id) on delete cascade,
  pair_id uuid not null references public.pairs (id) on delete cascade,
  actor_user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'delivered', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists notification_outbox_pending_idx
  on public.notification_outbox (available_at, created_at)
  where status in ('pending', 'failed');

-- A private replay cache preserves the exact successful HTTP payload. It is
-- never consulted for current state reads and therefore is not a persisted pet
-- stat; it exists solely to honor HTTP idempotency across later state changes.
create table if not exists public.care_idempotency_results (
  actor_user_id uuid not null references auth.users (id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  activity_id uuid not null unique references public.care_activities (id) on delete cascade,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_user_id, idempotency_key)
);

alter table public.feeding_schedules
  drop constraint if exists feeding_schedules_pet_pair_key;
alter table public.feeding_schedules
  add constraint feeding_schedules_pet_pair_key foreign key (pet_id, pair_id)
  references public.pets (id, pair_id) on delete cascade;
alter table public.treatment_schedules
  drop constraint if exists treatment_schedules_pet_pair_key;
alter table public.treatment_schedules
  add constraint treatment_schedules_pet_pair_key foreign key (pet_id, pair_id)
  references public.pets (id, pair_id) on delete cascade;
alter table public.care_activities
  drop constraint if exists care_activities_pet_pair_key;
alter table public.care_activities
  add constraint care_activities_pet_pair_key foreign key (pet_id, pair_id)
  references public.pets (id, pair_id) on delete restrict;

create or replace function public.valid_daily_times(candidate text[])
returns boolean
language sql
immutable
as $$
  select cardinality(candidate) between 1 and 8
     and not exists (
       select 1 from unnest(candidate) as value
        where value !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
     )
     and cardinality(candidate) = (
       select count(distinct value) from unnest(candidate) as value
     )
     and candidate = array(select value from unnest(candidate) as value order by value);
$$;

alter table public.feeding_schedules
  drop constraint if exists feeding_schedules_daily_times_valid;
alter table public.feeding_schedules
  add constraint feeding_schedules_daily_times_valid
  check (public.valid_daily_times(daily_times));
alter table public.treatment_schedules
  drop constraint if exists treatment_schedules_daily_times_valid;
alter table public.treatment_schedules
  add constraint treatment_schedules_daily_times_valid
  check (public.valid_daily_times(daily_times));

create or replace function public.is_pet_member(requested_user_id uuid, requested_pet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.pets pet
    join public.pair_memberships membership on membership.pair_id = pet.pair_id
    where pet.id = requested_pet_id and membership.user_id = requested_user_id
  );
$$;

create or replace function public.care_activity_to_json(activity public.care_activities)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', activity.id, 'petId', activity.pet_id,
    'actorUserId', activity.actor_user_id,
    'actorDisplayName', activity.actor_display_name,
    'type', activity.type, 'phase', activity.phase,
    'label', activity.label, 'note', activity.note,
    'treatmentScheduleId', activity.treatment_schedule_id,
    'scheduledFor', activity.scheduled_for,
    'occurredAt', activity.occurred_at,
    'idempotencyKey', activity.idempotency_key
  );
$$;

create or replace function public.active_pet_statuses(requested_pet_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'sleeping', coalesce((
      select phase = 'started' from public.care_activities
      where pet_id = requested_pet_id and type = 'sleep'
      order by occurred_at desc, id desc limit 1
    ), false),
    'alone', coalesce((
      select phase = 'started' from public.care_activities
      where pet_id = requested_pet_id and type = 'alone'
      order by occurred_at desc, id desc limit 1
    ), false)
  );
$$;

-- PostgreSQL resolves nonexistent local timestamps by shifting forward through
-- the DST gap, and ambiguous timestamps using the later standard-time offset.
create or replace function public.schedule_hint(
  requested_pet_id uuid,
  requested_timezone text,
  requested_daily_times text[],
  requested_kind text,
  requested_schedule_id uuid default null,
  requested_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  local_today date := (requested_now at time zone requested_timezone)::date;
  candidate timestamptz;
  last_completed timestamptz;
  state text;
begin
  if requested_schedule_id is null then
    select max(occurred_at) into last_completed
    from public.care_activities where pet_id = requested_pet_id and type = 'feed';
  else
    select max(occurred_at)
      into last_completed
    from public.care_activities
    where treatment_schedule_id = requested_schedule_id;
  end if;

  -- Select the newest currently actionable slot first. If that exact slot is
  -- complete, advance forward; never resurrect an older missed slot.
  select slot into candidate
  from (
    select ((day_value::date + time_value::time) at time zone requested_timezone) as slot
    from generate_series(local_today - 2, local_today + 2, interval '1 day') day_value
    cross join unnest(requested_daily_times) time_value
  ) slots
  where slot <= requested_now + interval '60 minutes'
  order by slot desc limit 1;

  if candidate is null or exists (
    select 1 from public.care_activities completed
    where ((requested_schedule_id is null and completed.pet_id = requested_pet_id and completed.type = 'feed')
           or completed.treatment_schedule_id = requested_schedule_id)
      and completed.scheduled_for = candidate
  ) then
    select min(slot) into candidate
    from (
      select ((day_value::date + time_value::time) at time zone requested_timezone) as slot
      from generate_series(local_today, local_today + 2, interval '1 day') day_value
      cross join unnest(requested_daily_times) time_value
    ) slots where slot > requested_now;
  end if;

  if candidate > requested_now + interval '60 minutes' then state := 'normal';
  elsif candidate > requested_now then state := 'approaching';
  elsif requested_now <= candidate + interval '60 minutes' then state := 'due';
  else state := 'overdue';
  end if;

  return jsonb_build_object(
    'scheduledFor', candidate,
    'lastCompletedAt', last_completed,
    'state', state
  );
end;
$$;

create or replace function public.newest_actionable_schedule_slot(
  requested_timezone text,
  requested_daily_times text[],
  requested_now timestamptz default statement_timestamp()
)
returns timestamptz
language sql
stable
as $$
  select max((day_value::date + time_value::time) at time zone requested_timezone)
  from generate_series(
    ((requested_now at time zone requested_timezone)::date) - 2,
    ((requested_now at time zone requested_timezone)::date) + 2,
    interval '1 day'
  ) day_value
  cross join unnest(requested_daily_times) time_value
  where ((day_value::date + time_value::time) at time zone requested_timezone)
        <= requested_now + interval '60 minutes';
$$;

create or replace function public.feeding_hint(
  requested_pet_id uuid,
  requested_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare schedule public.feeding_schedules%rowtype; hint jsonb;
begin
  select * into schedule from public.feeding_schedules where pet_id = requested_pet_id;
  if not found then return null; end if;
  hint := public.schedule_hint(requested_pet_id, schedule.timezone, schedule.daily_times, 'feed', null, requested_now);
  return jsonb_build_object(
    'nextFeedAt', hint -> 'scheduledFor',
    'lastFedAt', hint -> 'lastCompletedAt',
    'state', hint -> 'state'
  );
end;
$$;

create or replace function public.treatment_state(
  schedule public.treatment_schedules,
  requested_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schedule', jsonb_build_object(
      'id', schedule.id, 'petId', schedule.pet_id, 'kind', schedule.kind,
      'name', schedule.name, 'timezone', schedule.timezone,
      'dailyTimes', schedule.daily_times, 'active', schedule.active,
      'createdAt', schedule.created_at, 'updatedAt', schedule.updated_at
    ),
    'hint', public.schedule_hint(schedule.pet_id, schedule.timezone,
      schedule.daily_times, schedule.kind, schedule.id, requested_now)
  );
$$;

create or replace function public.get_activity_state(requested_user_id uuid, requested_pet_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if not public.is_pet_member(requested_user_id, requested_pet_id) then
    raise exception using errcode = 'P0001', message = 'PET_NOT_FOUND';
  end if;
  select jsonb_build_object(
    'pet', jsonb_build_object('id', pet.id, 'name', pet.name, 'createdAt', pet.created_at),
    'activeStatuses', public.active_pet_statuses(pet.id),
    'feedingSchedule', case when feeding.pet_id is null then null else jsonb_build_object(
      'timezone', feeding.timezone, 'dailyTimes', feeding.daily_times) end,
    'feedingHint', public.feeding_hint(pet.id),
    'treatmentStates', coalesce((select jsonb_agg(public.treatment_state(t) order by t.kind, lower(t.name))
      from public.treatment_schedules t where t.pet_id = pet.id and t.active), '[]'::jsonb),
    'recentActivities', coalesce((select jsonb_agg(public.care_activity_to_json(a) order by a.occurred_at desc, a.id desc)
      from (select * from public.care_activities where pet_id = pet.id
            order by occurred_at desc, id desc limit 20) a), '[]'::jsonb)
  ) into result
  from public.pets pet left join public.feeding_schedules feeding on feeding.pet_id = pet.id
  where pet.id = requested_pet_id;
  return result;
end;
$$;

create or replace function public.list_care_activities(
  requested_user_id uuid, requested_pet_id uuid, requested_limit integer,
  cursor_occurred_at timestamptz default null, cursor_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare items jsonb; next_row public.care_activities%rowtype; has_more boolean;
begin
  if not public.is_pet_member(requested_user_id, requested_pet_id) then
    raise exception using errcode = 'P0001', message = 'PET_NOT_FOUND';
  end if;
  if requested_limit not between 1 and 50 or ((cursor_occurred_at is null) <> (cursor_id is null)) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_ERROR';
  end if;
  select coalesce(jsonb_agg(public.care_activity_to_json(a) order by occurred_at desc, id desc), '[]'::jsonb)
    into items from (
      select * from public.care_activities
      where pet_id = requested_pet_id
        and (cursor_occurred_at is null or (occurred_at, id) < (cursor_occurred_at, cursor_id))
      order by occurred_at desc, id desc limit requested_limit
    ) a;
  select * into next_row from public.care_activities
    where pet_id = requested_pet_id
      and (cursor_occurred_at is null or (occurred_at, id) < (cursor_occurred_at, cursor_id))
    order by occurred_at desc, id desc offset requested_limit - 1 limit 1;
  select exists(select 1 from public.care_activities
    where pet_id=requested_pet_id
      and (cursor_occurred_at is null or (occurred_at,id)<(cursor_occurred_at,cursor_id))
    order by occurred_at desc,id desc offset requested_limit limit 1) into has_more;
  return jsonb_build_object(
    'items', items,
    'nextCursorOccurredAt', case when has_more then next_row.occurred_at else null end,
    'nextCursorId', case when has_more then next_row.id else null end
  );
end;
$$;

create or replace function public.put_feeding_schedule(
  requested_user_id uuid, requested_pet_id uuid, requested_timezone text, requested_daily_times text[]
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare pair_value uuid; schedule public.feeding_schedules%rowtype;
begin
  select pet.pair_id into pair_value from public.pets pet
  join public.pair_memberships member on member.pair_id = pet.pair_id
  where pet.id = requested_pet_id and member.user_id = requested_user_id;
  if pair_value is null then raise exception using errcode='P0001', message='PET_NOT_FOUND'; end if;
  if not public.valid_daily_times(requested_daily_times)
     or not exists (select 1 from pg_timezone_names where name = requested_timezone) then
    raise exception using errcode='P0001', message='VALIDATION_ERROR';
  end if;
  insert into public.feeding_schedules(pet_id,pair_id,timezone,daily_times)
  values(requested_pet_id,pair_value,requested_timezone,requested_daily_times)
  on conflict(pet_id) do update set timezone=excluded.timezone,daily_times=excluded.daily_times,updated_at=now()
  returning * into schedule;
  return jsonb_build_object('feedingSchedule',jsonb_build_object('timezone',schedule.timezone,'dailyTimes',schedule.daily_times),
    'feedingHint',public.feeding_hint(requested_pet_id));
end; $$;

create or replace function public.list_treatment_schedules(requested_user_id uuid, requested_pet_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare items jsonb;
begin
  if not public.is_pet_member(requested_user_id, requested_pet_id) then raise exception using errcode='P0001',message='PET_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(public.treatment_state(s) order by s.kind,lower(s.name)),'[]'::jsonb)
    into items from public.treatment_schedules s where s.pet_id=requested_pet_id and s.active;
  return jsonb_build_object('items',items);
end; $$;

create or replace function public.create_treatment_schedule(
  requested_user_id uuid, requested_pet_id uuid, requested_kind text, requested_name text,
  requested_timezone text, requested_daily_times text[]
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare pair_value uuid; schedule public.treatment_schedules%rowtype;
begin
  select pet.pair_id into pair_value from public.pets pet join public.pair_memberships m on m.pair_id=pet.pair_id
  where pet.id=requested_pet_id and m.user_id=requested_user_id;
  if pair_value is null then raise exception using errcode='P0001',message='PET_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('treatment-schedules:'||requested_pet_id::text,0));
  if (select count(*) from public.treatment_schedules where pet_id=requested_pet_id and active)>=20 then
    raise exception using errcode='P0001',message='TREATMENT_SCHEDULE_LIMIT_REACHED'; end if;
  if requested_kind not in ('medicine','ointment') or requested_name is null or requested_name<>btrim(requested_name)
     or char_length(requested_name) not between 1 and 60 or not public.valid_daily_times(requested_daily_times)
     or not exists(select 1 from pg_timezone_names where name=requested_timezone) then
    raise exception using errcode='P0001',message='VALIDATION_ERROR'; end if;
  insert into public.treatment_schedules(pet_id,pair_id,kind,name,timezone,daily_times)
  values(requested_pet_id,pair_value,requested_kind,requested_name,requested_timezone,requested_daily_times)
  returning * into schedule;
  return jsonb_build_object('treatmentState',public.treatment_state(schedule));
end; $$;

create or replace function public.update_treatment_schedule(
  requested_user_id uuid, requested_pet_id uuid, requested_schedule_id uuid,
  requested_name text, requested_timezone text, requested_daily_times text[],
  update_name boolean, update_timezone boolean, update_daily_times boolean
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare schedule public.treatment_schedules%rowtype;
begin
  if not public.is_pet_member(requested_user_id,requested_pet_id) then raise exception using errcode='P0001',message='PET_NOT_FOUND'; end if;
  select * into schedule from public.treatment_schedules where id=requested_schedule_id and pet_id=requested_pet_id and active for update;
  if not found then raise exception using errcode='P0001',message='TREATMENT_SCHEDULE_NOT_FOUND'; end if;
  if not (update_name or update_timezone or update_daily_times) then raise exception using errcode='P0001',message='VALIDATION_ERROR'; end if;
  if (update_name and (requested_name is null or requested_name<>btrim(requested_name) or char_length(requested_name) not between 1 and 60))
    or (update_timezone and (requested_timezone is null or not exists(select 1 from pg_timezone_names where name=requested_timezone)))
    or (update_daily_times and not public.valid_daily_times(requested_daily_times)) then
    raise exception using errcode='P0001',message='VALIDATION_ERROR'; end if;
  update public.treatment_schedules set
    name=case when update_name then requested_name else name end,
    timezone=case when update_timezone then requested_timezone else timezone end,
    daily_times=case when update_daily_times then requested_daily_times else daily_times end,
    updated_at=statement_timestamp()
  where id=requested_schedule_id returning * into schedule;
  return jsonb_build_object('treatmentState',public.treatment_state(schedule));
end; $$;

create or replace function public.archive_treatment_schedule(
  requested_user_id uuid, requested_pet_id uuid, requested_schedule_id uuid
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_pet_member(requested_user_id,requested_pet_id) then raise exception using errcode='P0001',message='PET_NOT_FOUND'; end if;
  update public.treatment_schedules set active=false,archived_at=statement_timestamp(),updated_at=statement_timestamp()
  where id=requested_schedule_id and pet_id=requested_pet_id and active;
  if not found then raise exception using errcode='P0001',message='TREATMENT_SCHEDULE_NOT_FOUND'; end if;
end; $$;

create or replace function public.create_care_activity(
  requested_user_id uuid, requested_pet_id uuid, requested_type text, requested_phase text,
  requested_label text, requested_note text, requested_treatment_schedule_id uuid,
  requested_idempotency_key text, requested_request_hash text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare pair_value uuid; profile_name text; replay public.care_idempotency_results%rowtype;
  activity public.care_activities%rowtype; status jsonb; feed_hint jsonb; treatment public.treatment_schedules%rowtype;
  feeding public.feeding_schedules%rowtype; treatment_hint jsonb; slot timestamptz;
  created_count integer; response_value jsonb;
begin
  select pet.pair_id,profile.display_name into pair_value,profile_name
  from public.pets pet join public.pair_memberships m on m.pair_id=pet.pair_id
  left join public.user_profiles profile on profile.user_id=requested_user_id
  where pet.id=requested_pet_id and m.user_id=requested_user_id;
  if pair_value is null then raise exception using errcode='P0001',message='PET_NOT_FOUND'; end if;
  if requested_idempotency_key is null or char_length(requested_idempotency_key) not between 1 and 128
     or requested_idempotency_key !~ '^[\x20-\x7e]+$' or requested_request_hash is null
     or requested_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='P0001',message='VALIDATION_ERROR'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'idempotency:'||requested_user_id::text||':'||requested_idempotency_key,0));
  select * into replay from public.care_idempotency_results
    where actor_user_id=requested_user_id and idempotency_key=requested_idempotency_key;
  if found then
    if replay.request_hash<>requested_request_hash then raise exception using errcode='P0001',message='IDEMPOTENCY_CONFLICT'; end if;
    return replay.response_body;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('activity:'||requested_pet_id::text,0));
  select count(*)::integer into created_count from public.care_activities
   where actor_user_id=requested_user_id and pet_id=requested_pet_id and occurred_at>statement_timestamp()-interval '1 minute';
  if created_count>=30 then raise exception using errcode='P0001',message='RATE_LIMITED'; end if;

  if requested_note is not null and (requested_note<>btrim(requested_note) or char_length(requested_note)>500 or requested_note='') then
    raise exception using errcode='P0001',message='VALIDATION_ERROR'; end if;
  if requested_type in ('sleep','alone') then
    status:=public.active_pet_statuses(requested_pet_id);
    if requested_phase='started' and (status->>case when requested_type='sleep' then 'sleeping' else 'alone' end)::boolean then
      raise exception using errcode='P0001',message='STATUS_ALREADY_ACTIVE'; end if;
    if requested_phase='ended' and not (status->>case when requested_type='sleep' then 'sleeping' else 'alone' end)::boolean then
      raise exception using errcode='P0001',message='STATUS_NOT_ACTIVE'; end if;
  elsif requested_type in ('medicine','ointment') then
    select * into treatment from public.treatment_schedules where id=requested_treatment_schedule_id
      and pet_id=requested_pet_id and active for update;
    if not found then raise exception using errcode='P0001',message='TREATMENT_SCHEDULE_NOT_FOUND'; end if;
    if treatment.kind<>requested_type then raise exception using errcode='P0001',message='VALIDATION_ERROR'; end if;
    slot:=public.newest_actionable_schedule_slot(treatment.timezone,treatment.daily_times);
    if exists(select 1 from public.care_activities where treatment_schedule_id=treatment.id and scheduled_for=slot) then
      raise exception using errcode='P0001',message='SCHEDULE_SLOT_ALREADY_COMPLETED'; end if;
    treatment_hint:=public.schedule_hint(requested_pet_id,treatment.timezone,treatment.daily_times,treatment.kind,treatment.id);
    if treatment_hint->>'state'='normal' then raise exception using errcode='P0001',message='TREATMENT_NOT_DUE'; end if;
    slot:=(treatment_hint->>'scheduledFor')::timestamptz;
    requested_label:=treatment.name;
  elsif requested_type='feed' then
    select * into feeding from public.feeding_schedules where pet_id=requested_pet_id;
    if found then
      slot:=public.newest_actionable_schedule_slot(feeding.timezone,feeding.daily_times);
      if exists(select 1 from public.care_activities where pet_id=requested_pet_id and type='feed' and scheduled_for=slot) then
        raise exception using errcode='P0001',message='SCHEDULE_SLOT_ALREADY_COMPLETED'; end if;
    end if;
    feed_hint:=public.feeding_hint(requested_pet_id);
    if feed_hint is not null and feed_hint->>'state'<>'normal' then slot:=(feed_hint->>'nextFeedAt')::timestamptz; end if;
  end if;

  insert into public.care_activities(pet_id,pair_id,actor_user_id,actor_display_name,type,phase,label,note,
    treatment_schedule_id,scheduled_for,idempotency_key,request_hash)
  values(requested_pet_id,pair_value,requested_user_id,profile_name,requested_type,requested_phase,requested_label,
    requested_note,requested_treatment_schedule_id,slot,requested_idempotency_key,requested_request_hash)
  returning * into activity;
  insert into public.notification_outbox(activity_id,pair_id,actor_user_id)
  values(activity.id,pair_value,requested_user_id);
  if requested_treatment_schedule_id is not null then select * into treatment from public.treatment_schedules where id=requested_treatment_schedule_id; end if;
  response_value:=jsonb_build_object('activity',public.care_activity_to_json(activity),'state',jsonb_build_object(
    'activeStatuses',public.active_pet_statuses(requested_pet_id),'feedingHint',public.feeding_hint(requested_pet_id),
    'treatmentState',case when requested_treatment_schedule_id is null then null else public.treatment_state(treatment) end));
  insert into public.care_idempotency_results(actor_user_id,idempotency_key,request_hash,activity_id,response_body)
  values(requested_user_id,requested_idempotency_key,requested_request_hash,activity.id,response_value);
  return response_value;
exception when unique_violation then
  if slot is not null then raise exception using errcode='P0001',message='SCHEDULE_SLOT_ALREADY_COMPLETED'; end if;
  raise;
end; $$;

create or replace function public.prevent_care_activity_mutation()
returns trigger language plpgsql as $$ begin raise exception 'CARE_ACTIVITY_IMMUTABLE'; end; $$;
drop trigger if exists care_activities_immutable on public.care_activities;
create trigger care_activities_immutable before update or delete on public.care_activities
for each row execute function public.prevent_care_activity_mutation();

alter table public.feeding_schedules enable row level security;
alter table public.treatment_schedules enable row level security;
alter table public.care_activities enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.care_idempotency_results enable row level security;
drop policy if exists feeding_schedules_pair_read on public.feeding_schedules;
create policy feeding_schedules_pair_read on public.feeding_schedules for select to authenticated using(public.is_pair_member(pair_id));
drop policy if exists treatment_schedules_pair_read on public.treatment_schedules;
create policy treatment_schedules_pair_read on public.treatment_schedules for select to authenticated using(public.is_pair_member(pair_id));
drop policy if exists care_activities_pair_read on public.care_activities;
create policy care_activities_pair_read on public.care_activities for select to authenticated using(public.is_pair_member(pair_id));
-- Outbox is worker-only and intentionally has no client policy.
revoke all on public.feeding_schedules,public.treatment_schedules,public.care_activities,public.notification_outbox from anon,authenticated;
revoke all on public.care_idempotency_results from anon,authenticated;
grant select on public.feeding_schedules,public.treatment_schedules,public.care_activities to authenticated;
grant select,update on public.notification_outbox to service_role;

revoke all on function public.is_pet_member(uuid,uuid),public.get_activity_state(uuid,uuid),
  public.list_care_activities(uuid,uuid,integer,timestamptz,uuid),public.put_feeding_schedule(uuid,uuid,text,text[]),
  public.list_treatment_schedules(uuid,uuid),public.create_treatment_schedule(uuid,uuid,text,text,text,text[]),
  public.update_treatment_schedule(uuid,uuid,uuid,text,text,text[],boolean,boolean,boolean),
  public.archive_treatment_schedule(uuid,uuid,uuid),
  public.create_care_activity(uuid,uuid,text,text,text,text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.valid_daily_times(text[]),public.care_activity_to_json(public.care_activities),
  public.active_pet_statuses(uuid),public.schedule_hint(uuid,text,text[],text,uuid,timestamptz),
  public.newest_actionable_schedule_slot(text,text[],timestamptz),
  public.feeding_hint(uuid,timestamptz),public.treatment_state(public.treatment_schedules,timestamptz),
  public.prevent_care_activity_mutation() from public,anon,authenticated;
grant execute on function public.get_activity_state(uuid,uuid),public.list_care_activities(uuid,uuid,integer,timestamptz,uuid),
  public.put_feeding_schedule(uuid,uuid,text,text[]),public.list_treatment_schedules(uuid,uuid),
  public.create_treatment_schedule(uuid,uuid,text,text,text,text[]),
  public.update_treatment_schedule(uuid,uuid,uuid,text,text,text[],boolean,boolean,boolean),
  public.archive_treatment_schedule(uuid,uuid,uuid),public.create_care_activity(uuid,uuid,text,text,text,text,uuid,text,text)
  to service_role;

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='care_activities') then
      alter publication supabase_realtime add table public.care_activities; end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='feeding_schedules') then
      alter publication supabase_realtime add table public.feeding_schedules; end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='treatment_schedules') then
      alter publication supabase_realtime add table public.treatment_schedules; end if;
  end if;
end $$;

alter table public.care_activities replica identity full;
alter table public.feeding_schedules replica identity full;
alter table public.treatment_schedules replica identity full;
