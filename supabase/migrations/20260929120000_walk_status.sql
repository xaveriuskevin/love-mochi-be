-- Adds `walk` as a third start/stop status alongside `sleep` and `alone`.
-- Walk is independent of the other statuses (no cross-status rules).

alter table public.care_activities
  drop constraint if exists care_activities_type_check;
alter table public.care_activities
  add constraint care_activities_type_check check (
    type in ('feed', 'poop', 'play', 'sleep', 'alone', 'walk', 'custom', 'medicine', 'ointment')
  );

alter table public.care_activities
  drop constraint if exists care_activities_shape;
alter table public.care_activities
  add constraint care_activities_shape check (
    (type in ('feed', 'poop', 'play') and phase is null and label is null and treatment_schedule_id is null)
    or (type in ('sleep', 'alone', 'walk') and phase is not null and label is null and treatment_schedule_id is null and scheduled_for is null)
    or (type = 'custom' and phase is null and label is not null and treatment_schedule_id is null and scheduled_for is null)
    or (type in ('medicine', 'ointment') and phase is null and label is not null and treatment_schedule_id is not null and scheduled_for is not null)
  );

drop index if exists public.care_activities_status_idx;
create index if not exists care_activities_status_idx
  on public.care_activities (pet_id, type, occurred_at desc, id desc)
  where type in ('sleep', 'alone', 'walk');

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
    ), false),
    'walking', coalesce((
      select phase = 'started' from public.care_activities
      where pet_id = requested_pet_id and type = 'walk'
      order by occurred_at desc, id desc limit 1
    ), false)
  );
$$;

create or replace function public.create_care_activity(
  requested_user_id uuid, requested_pet_id uuid, requested_type text, requested_phase text,
  requested_label text, requested_note text, requested_treatment_schedule_id uuid,
  requested_idempotency_key text, requested_request_hash text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare pair_value uuid; profile_name text; replay public.care_idempotency_results%rowtype;
  activity public.care_activities%rowtype; status jsonb; status_key text; feed_hint jsonb; treatment public.treatment_schedules%rowtype;
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
  if requested_type in ('sleep','alone','walk') then
    status:=public.active_pet_statuses(requested_pet_id);
    status_key:=case requested_type when 'sleep' then 'sleeping' when 'walk' then 'walking' else 'alone' end;
    if requested_phase='started' and (status->>status_key)::boolean then
      raise exception using errcode='P0001',message='STATUS_ALREADY_ACTIVE'; end if;
    if requested_phase='ended' and not (status->>status_key)::boolean then
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
