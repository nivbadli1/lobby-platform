-- Schema v1: changes agreed on day 2. The schema is FROZEN after this file;
-- later changes need an explicit decision and a new migration.

-- ---------------------------------------------------------------- committee approval policy

alter table buildings
  add column approval_policy text not null default 'first'
    check (approval_policy in ('first', 'majority', 'all')),
  -- Per-building bank CSV layout: {"preset": "...", "encoding": "...", "columns": {date, amount, reference, payer_name}}
  add column bank_csv_mapping jsonb;

alter table approvals
  add constraint approvals_company_id_id_key unique (company_id, id),
  -- Snapshot at request time, so the outcome does not shift if the building's
  -- policy or committee changes while a request is open.
  add column policy text not null default 'first' check (policy in ('first', 'majority', 'all')),
  add column eligible_voters integer not null default 1 check (eligible_voters > 0);

comment on column approvals.decided_by is 'Committee member whose vote settled the outcome';

create table approval_votes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  approval_id uuid not null,
  person_id uuid not null,
  decision text not null check (decision in ('approved', 'rejected')),
  decided_at timestamptz not null default now(),
  unique (approval_id, person_id),
  foreign key (company_id, approval_id) references approvals (company_id, id) on delete cascade,
  foreign key (company_id, person_id) references people (company_id, id)
);

alter table approval_votes enable row level security;
create policy approval_votes_company_isolation on approval_votes for all to authenticated
  using (company_id in (select public.current_company_ids()))
  with check (company_id in (select public.current_company_ids()));

-- ---------------------------------------------------------------- billing / vendors

alter table payments add column payer_name text;

-- Vendor imports upsert on phone.
alter table vendors add constraint vendors_company_id_phone_e164_key unique (company_id, phone_e164);

-- ---------------------------------------------------------------- inbound message processing

alter table messages
  add column processed_at timestamptz, -- inbound only: fully handled (reply sent)
  add column claimed_at timestamptz,   -- inbound only: a worker is handling it
  add column attempts integer not null default 0;

create index messages_unprocessed on messages (created_at)
  where direction = 'in' and processed_at is null;

-- Atomically claims an inbound message for processing.
--   claimed   -> caller must process it, then set processed_at (or clear claimed_at on failure)
--   done      -> already processed; skip
--   in_flight -> another invocation holds a fresh claim; ask the sender to retry later
--   exhausted -> failed p_max_attempts times; skip and surface to admin
create function public.claim_inbound_message(
  p_company_id uuid,
  p_wa_message_id text,
  p_max_attempts integer default 5,
  p_lease_seconds integer default 120
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  m public.messages;
begin
  select * into m from public.messages
  where company_id = p_company_id and wa_message_id = p_wa_message_id and direction = 'in'
  for update;

  if not found then return 'missing'; end if;
  if m.processed_at is not null then return 'done'; end if;
  if m.claimed_at is not null and m.claimed_at > now() - make_interval(secs => p_lease_seconds) then
    return 'in_flight';
  end if;
  if m.attempts >= p_max_attempts then return 'exhausted'; end if;

  update public.messages set attempts = attempts + 1, claimed_at = now() where id = m.id;
  return 'claimed';
end $$;
revoke all on function public.claim_inbound_message(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_inbound_message(uuid, text, integer, integer) to service_role;

-- ---------------------------------------------------------------- storage: ticket media

-- Private bucket. Object path convention: <company_id>/<ticket_id>/<file>.
-- Uploads happen server-side with the service role; staff may read their company's files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ticket-media', 'ticket-media', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4', 'application/pdf']
)
on conflict (id) do nothing;

create policy ticket_media_company_read on storage.objects for select to authenticated
  using (
    bucket_id = 'ticket-media'
    and (storage.foldername(name))[1] in (select public.current_company_ids()::text)
  );

-- ---------------------------------------------------------------- onboarding imports
-- Each import is one transaction (all rows or none) and is safe to re-run.
-- SECURITY INVOKER: RLS applies, so staff can only import into their own buildings.
-- Rows arrive validated and normalised by the app (src/lib/import).

create function public.import_units(p_building_id uuid, p_rows jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_count integer;
begin
  select company_id into v_company_id from public.buildings where id = p_building_id;
  if v_company_id is null then raise exception 'building not found'; end if;

  insert into public.units (company_id, building_id, floor, number, sqm)
  select v_company_id, p_building_id, (r ->> 'floor')::integer, r ->> 'number', (r ->> 'sqm')::numeric
  from jsonb_array_elements(p_rows) as r
  on conflict (building_id, number) do update set floor = excluded.floor, sqm = excluded.sqm;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- One row per person-unit-role: {full_name, phone_e164, lang, unit_number, role, is_payer, receives_updates}
create function public.import_people(p_building_id uuid, p_rows jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_missing text;
  v_count integer;
begin
  select company_id into v_company_id from public.buildings where id = p_building_id;
  if v_company_id is null then raise exception 'building not found'; end if;

  select string_agg(distinct r ->> 'unit_number', ', ') into v_missing
  from jsonb_array_elements(p_rows) as r
  where not exists (
    select 1 from public.units u where u.building_id = p_building_id and u.number = r ->> 'unit_number'
  );
  if v_missing is not null then raise exception 'unknown units: %', v_missing; end if;

  insert into public.people (company_id, full_name, phone_e164, lang)
  select distinct on (r ->> 'phone_e164')
    v_company_id, r ->> 'full_name', r ->> 'phone_e164', coalesce(r ->> 'lang', 'he')
  from jsonb_array_elements(p_rows) as r
  on conflict (company_id, phone_e164) do update
    set full_name = excluded.full_name, lang = excluded.lang, needs_verification = false;

  -- A unit has one payer: the file's payer replaces the current one.
  update public.unit_roles ur set is_payer = false
  from public.units u
  where ur.unit_id = u.id and ur.is_payer and u.building_id = p_building_id
    and u.number in (
      select r ->> 'unit_number' from jsonb_array_elements(p_rows) as r where (r ->> 'is_payer')::boolean
    );

  insert into public.unit_roles (company_id, unit_id, person_id, role, is_payer, receives_updates)
  select v_company_id, u.id, p.id, r ->> 'role',
         coalesce((r ->> 'is_payer')::boolean, false), coalesce((r ->> 'receives_updates')::boolean, true)
  from jsonb_array_elements(p_rows) as r
  join public.units u on u.building_id = p_building_id and u.number = r ->> 'unit_number'
  join public.people p on p.company_id = v_company_id and p.phone_e164 = r ->> 'phone_e164'
  on conflict (unit_id, person_id, role) do update
    set is_payer = excluded.is_payer, receives_updates = excluded.receives_updates;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- {name, phone_e164, categories: [..], is_default}. Vendors are company-wide, so
-- categories are merged with what the vendor already has. is_default makes the
-- vendor this building's default for each of the row's categories.
create function public.import_vendors(p_building_id uuid, p_rows jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_count integer;
begin
  select company_id into v_company_id from public.buildings where id = p_building_id;
  if v_company_id is null then raise exception 'building not found'; end if;

  insert into public.vendors (company_id, name, phone_e164, categories)
  select v_company_id, r ->> 'name', r ->> 'phone_e164',
         array(select jsonb_array_elements_text(r -> 'categories'))
  from jsonb_array_elements(p_rows) as r
  on conflict (company_id, phone_e164) do update
    set name = excluded.name,
        categories = array(select distinct c from unnest(public.vendors.categories || excluded.categories) as c order by c);

  get diagnostics v_count = row_count;

  insert into public.building_vendor_defaults (company_id, building_id, category, vendor_id)
  select v_company_id, p_building_id, c, v.id
  from jsonb_array_elements(p_rows) as r
  join public.vendors v on v.company_id = v_company_id and v.phone_e164 = r ->> 'phone_e164'
  cross join lateral jsonb_array_elements_text(r -> 'categories') as c
  where (r ->> 'is_default')::boolean
  on conflict (building_id, category) do update set vendor_id = excluded.vendor_id;

  return v_count;
end $$;

revoke all on function public.import_units(uuid, jsonb) from public, anon;
revoke all on function public.import_people(uuid, jsonb) from public, anon;
revoke all on function public.import_vendors(uuid, jsonb) from public, anon;
grant execute on function public.import_units(uuid, jsonb) to authenticated, service_role;
grant execute on function public.import_people(uuid, jsonb) to authenticated, service_role;
grant execute on function public.import_vendors(uuid, jsonb) to authenticated, service_role;
