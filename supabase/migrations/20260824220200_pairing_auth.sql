-- Pairing and authentication foundation.
--
-- Invite plaintext must never be passed to or stored by PostgreSQL. API callers
-- generate an unambiguous six-character code and pass only its lowercase
-- SHA-256 hex digest to the RPCs below.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_profiles_display_name_length
    check (display_name is null or char_length(display_name) between 1 and 80)
);

create table if not exists public.pairs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists public.pair_memberships (
  pair_id uuid not null references public.pairs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  joined_at timestamptz not null default now(),
  primary key (pair_id, user_id),
  constraint pair_memberships_one_pair_per_user unique (user_id),
  constraint pair_memberships_role check (role in ('creator', 'member'))
);

create unique index if not exists pair_memberships_one_creator_per_pair
  on public.pair_memberships (pair_id)
  where role = 'creator';

create table if not exists public.pets (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references public.pairs (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  constraint pets_name_length check (char_length(btrim(name)) between 1 and 40),
  constraint pets_name_is_trimmed check (name = btrim(name))
);

create index if not exists pets_pair_id_idx on public.pets (pair_id);

create table if not exists public.pair_invites (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references public.pairs (id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '72 hours'),
  consumed_at timestamptz,
  consumed_by uuid references auth.users (id) on delete set null,
  constraint pair_invites_code_hash_format check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint pair_invites_positive_expiry check (expires_at > created_at),
  constraint pair_invites_maximum_expiry
    check (expires_at <= created_at + interval '72 hours'),
  constraint pair_invites_consumption_consistent check (
    (consumed_at is null and consumed_by is null)
    or consumed_at is not null
  )
);

create unique index if not exists pair_invites_code_hash_key
  on public.pair_invites (code_hash);

-- There may be only one usable invite for a pair. Rotation first consumes the
-- old row, preserving audit history without retaining plaintext.
create unique index if not exists pair_invites_one_unconsumed_per_pair
  on public.pair_invites (pair_id)
  where consumed_at is null;

create index if not exists pair_invites_pair_id_idx
  on public.pair_invites (pair_id);

create or replace function public.sync_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.user_profiles (user_id, display_name)
  values (
    new.id,
    nullif(btrim(coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name'
    )), '')
  )
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists sync_auth_user_profile on auth.users;
create trigger sync_auth_user_profile
after insert or update of raw_user_meta_data on auth.users
for each row execute function public.sync_auth_user_profile();

-- Backfill profiles for Auth users that existed before this migration.
insert into public.user_profiles (user_id, display_name)
select
  users.id,
  nullif(btrim(coalesce(
    users.raw_user_meta_data ->> 'display_name',
    users.raw_user_meta_data ->> 'full_name'
  )), '')
from auth.users as users
on conflict (user_id) do nothing;

create or replace function public.enforce_pair_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_member_count integer;
begin
  -- Serialize all membership changes for this pair, including changes made
  -- outside the join RPC.
  perform pg_advisory_xact_lock(hashtextextended('pair:' || new.pair_id::text, 0));

  if tg_op = 'UPDATE' and new.pair_id = old.pair_id then
    return new;
  end if;

  select count(*)::integer
    into current_member_count
    from public.pair_memberships as membership
   where membership.pair_id = new.pair_id;

  if current_member_count >= 2 then
    raise exception using
      errcode = 'P0001',
      message = 'PAIR_FULL';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_pair_capacity on public.pair_memberships;
create trigger enforce_pair_capacity
before insert or update of pair_id on public.pair_memberships
for each row execute function public.enforce_pair_capacity();

-- Used only by RLS policies. Keeping this lookup in a SECURITY DEFINER helper
-- avoids recursive policies on pair_memberships.
create or replace function public.is_pair_member(requested_pair_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.pair_memberships as membership
     where membership.pair_id = requested_pair_id
       and membership.user_id = auth.uid()
  );
$$;

create or replace function public.get_my_workspace(requested_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  workspace jsonb;
begin
  if not exists (select 1 from auth.users where id = requested_user_id) then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', auth_user.id,
      'displayName', profile.display_name
    ),
    'pair', case when pair_row.id is null then null else jsonb_build_object(
      'id', pair_row.id,
      'createdAt', pair_row.created_at,
      'memberCount', pair_row.member_count
    ) end,
    'pet', case when pet_row.id is null then null else jsonb_build_object(
      'id', pet_row.id,
      'name', pet_row.name,
      'createdAt', pet_row.created_at
    ) end,
    'membership', case when membership.pair_id is null then null else jsonb_build_object(
      'pairId', membership.pair_id,
      'userId', membership.user_id,
      'role', membership.role,
      'joinedAt', membership.joined_at
    ) end
  )
  into workspace
  from auth.users as auth_user
  left join public.user_profiles as profile
    on profile.user_id = auth_user.id
  left join public.pair_memberships as membership
    on membership.user_id = auth_user.id
  left join lateral (
    select pair_record.id,
           pair_record.created_at,
           count(all_members.user_id)::integer as member_count
      from public.pairs as pair_record
      left join public.pair_memberships as all_members
        on all_members.pair_id = pair_record.id
     where pair_record.id = membership.pair_id
     group by pair_record.id, pair_record.created_at
  ) as pair_row on true
  left join lateral (
    select pet_record.id, pet_record.name, pet_record.created_at
      from public.pets as pet_record
     where pet_record.pair_id = membership.pair_id
     order by pet_record.created_at, pet_record.id
     limit 1
  ) as pet_row on true
  where auth_user.id = requested_user_id;

  return workspace;
end;
$$;

create or replace function public.create_pair(
  requested_user_id uuid,
  requested_pet_name text,
  requested_invite_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created_pair public.pairs%rowtype;
  created_membership public.pair_memberships%rowtype;
  created_pet public.pets%rowtype;
  created_invite public.pair_invites%rowtype;
  normalized_pet_name text := btrim(requested_pet_name);
begin
  if not exists (select 1 from auth.users where id = requested_user_id) then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  if normalized_pet_name is null
     or char_length(normalized_pet_name) not between 1 and 40
     or requested_invite_hash is null
     or requested_invite_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_ERROR';
  end if;

  -- Serialize create/join attempts for this user before checking membership.
  perform pg_advisory_xact_lock(hashtextextended('user:' || requested_user_id::text, 0));

  if exists (
    select 1 from public.pair_memberships where user_id = requested_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'USER_ALREADY_PAIRED';
  end if;

  insert into public.pairs default values returning * into created_pair;

  insert into public.pair_memberships (pair_id, user_id, role)
  values (created_pair.id, requested_user_id, 'creator')
  returning * into created_membership;

  insert into public.pets (pair_id, name)
  values (created_pair.id, normalized_pet_name)
  returning * into created_pet;

  insert into public.pair_invites (pair_id, code_hash)
  values (created_pair.id, requested_invite_hash)
  returning * into created_invite;

  return jsonb_build_object(
    'pair', jsonb_build_object(
      'id', created_pair.id,
      'createdAt', created_pair.created_at,
      'memberCount', 1
    ),
    'pet', jsonb_build_object(
      'id', created_pet.id,
      'name', created_pet.name,
      'createdAt', created_pet.created_at
    ),
    'membership', jsonb_build_object(
      'pairId', created_membership.pair_id,
      'userId', created_membership.user_id,
      'role', created_membership.role,
      'joinedAt', created_membership.joined_at
    ),
    'inviteExpiresAt', created_invite.expires_at
  );
end;
$$;

create or replace function public.join_pair_by_invite(
  requested_user_id uuid,
  requested_invite_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_invite public.pair_invites%rowtype;
  existing_pair_id uuid;
  joined_membership public.pair_memberships%rowtype;
  selected_pair public.pairs%rowtype;
  selected_pet public.pets%rowtype;
  current_member_count integer;
begin
  if not exists (select 1 from auth.users where id = requested_user_id) then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  if requested_invite_hash is null
     or requested_invite_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'INVITE_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('user:' || requested_user_id::text, 0));

  select membership.pair_id
    into existing_pair_id
    from public.pair_memberships as membership
   where membership.user_id = requested_user_id;

  -- Read the pair id first, then take the pair advisory lock before locking the
  -- invite row. Rotation uses the same pair-then-invite order, avoiding a
  -- join/rotation deadlock.
  select invite.*
    into selected_invite
    from public.pair_invites as invite
   where invite.code_hash = requested_invite_hash
     and invite.consumed_at is null;

  if not found then
    raise exception using errcode = 'P0001', message = 'INVITE_INVALID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('pair:' || selected_invite.pair_id::text, 0)
  );

  select invite.*
    into selected_invite
    from public.pair_invites as invite
   where invite.id = selected_invite.id
     and invite.consumed_at is null
   for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'INVITE_INVALID';
  end if;

  if existing_pair_id is not null then
    if existing_pair_id = selected_invite.pair_id then
      raise exception using errcode = 'P0001', message = 'ALREADY_A_MEMBER';
    end if;

    raise exception using errcode = 'P0001', message = 'USER_ALREADY_PAIRED';
  end if;

  if selected_invite.expires_at <= statement_timestamp() then
    raise exception using errcode = 'P0001', message = 'INVITE_EXPIRED';
  end if;

  select count(*)::integer
    into current_member_count
    from public.pair_memberships as membership
   where membership.pair_id = selected_invite.pair_id;

  if current_member_count >= 2 then
    raise exception using errcode = 'P0001', message = 'PAIR_FULL';
  end if;

  insert into public.pair_memberships (pair_id, user_id, role)
  values (selected_invite.pair_id, requested_user_id, 'member')
  returning * into joined_membership;

  update public.pair_invites
     set consumed_at = statement_timestamp(),
         consumed_by = requested_user_id
   where id = selected_invite.id;

  select * into selected_pair
    from public.pairs
   where id = selected_invite.pair_id;

  select * into selected_pet
    from public.pets
   where pair_id = selected_invite.pair_id
   order by created_at, id
   limit 1;

  return jsonb_build_object(
    'pair', jsonb_build_object(
      'id', selected_pair.id,
      'createdAt', selected_pair.created_at,
      'memberCount', current_member_count + 1
    ),
    'pet', jsonb_build_object(
      'id', selected_pet.id,
      'name', selected_pet.name,
      'createdAt', selected_pet.created_at
    ),
    'membership', jsonb_build_object(
      'pairId', joined_membership.pair_id,
      'userId', joined_membership.user_id,
      'role', joined_membership.role,
      'joinedAt', joined_membership.joined_at
    )
  );
end;
$$;

create or replace function public.rotate_pair_invite(
  requested_user_id uuid,
  requested_invite_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_pair_id uuid;
  current_member_count integer;
  created_invite public.pair_invites%rowtype;
begin
  if requested_invite_hash is null
     or requested_invite_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_ERROR';
  end if;

  select membership.pair_id
    into selected_pair_id
    from public.pair_memberships as membership
   where membership.user_id = requested_user_id;

  if selected_pair_id is null then
    raise exception using errcode = 'P0001', message = 'PAIR_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pair:' || selected_pair_id::text, 0));

  select count(*)::integer
    into current_member_count
    from public.pair_memberships as membership
   where membership.pair_id = selected_pair_id;

  if current_member_count >= 2 then
    raise exception using errcode = 'P0001', message = 'PAIR_FULL';
  end if;

  update public.pair_invites
     set consumed_at = statement_timestamp(),
         consumed_by = null
   where pair_id = selected_pair_id
     and consumed_at is null;

  insert into public.pair_invites (pair_id, code_hash)
  values (selected_pair_id, requested_invite_hash)
  returning * into created_invite;

  return jsonb_build_object('inviteExpiresAt', created_invite.expires_at);
end;
$$;

alter table public.user_profiles enable row level security;
alter table public.pairs enable row level security;
alter table public.pair_memberships enable row level security;
alter table public.pets enable row level security;
alter table public.pair_invites enable row level security;

drop policy if exists user_profiles_select_own on public.user_profiles;
create policy user_profiles_select_own
on public.user_profiles for select
to authenticated
using (user_id = auth.uid());

drop policy if exists user_profiles_update_own on public.user_profiles;
create policy user_profiles_update_own
on public.user_profiles for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists pairs_select_for_members on public.pairs;
create policy pairs_select_for_members
on public.pairs for select
to authenticated
using (public.is_pair_member(id));

drop policy if exists pair_memberships_select_for_pair_members on public.pair_memberships;
create policy pair_memberships_select_for_pair_members
on public.pair_memberships for select
to authenticated
using (public.is_pair_member(pair_id));

drop policy if exists pets_select_for_pair_members on public.pets;
create policy pets_select_for_pair_members
on public.pets for select
to authenticated
using (public.is_pair_member(pair_id));

-- Invites deliberately have no client-readable policies. The backend exposes
-- only plaintext codes generated in memory and never the stored hash.

revoke all on table public.user_profiles from anon, authenticated;
revoke all on table public.pairs from anon, authenticated;
revoke all on table public.pair_memberships from anon, authenticated;
revoke all on table public.pets from anon, authenticated;
revoke all on table public.pair_invites from anon, authenticated;

grant select, update on table public.user_profiles to authenticated;
grant select on table public.pairs to authenticated;
grant select on table public.pair_memberships to authenticated;
grant select on table public.pets to authenticated;

revoke all on function public.sync_auth_user_profile() from public, anon, authenticated;
revoke all on function public.enforce_pair_capacity() from public, anon, authenticated;
revoke all on function public.is_pair_member(uuid) from public, anon;
revoke all on function public.get_my_workspace(uuid) from public, anon, authenticated;
revoke all on function public.create_pair(uuid, text, text) from public, anon, authenticated;
revoke all on function public.join_pair_by_invite(uuid, text) from public, anon, authenticated;
revoke all on function public.rotate_pair_invite(uuid, text) from public, anon, authenticated;

grant execute on function public.is_pair_member(uuid) to authenticated;
grant execute on function public.get_my_workspace(uuid) to service_role;
grant execute on function public.create_pair(uuid, text, text) to service_role;
grant execute on function public.join_pair_by_invite(uuid, text) to service_role;
grant execute on function public.rotate_pair_invite(uuid, text) to service_role;

comment on table public.pair_invites is
  'Hashed, single-use pairing invites. Plaintext codes must never enter this table.';
comment on column public.pair_invites.code_hash is
  'Lowercase SHA-256 hex digest of the six-character invite code.';
comment on function public.join_pair_by_invite(uuid, text) is
  'Atomically validates and consumes an invite while enforcing user and pair membership limits.';
