-- Schema v0 for the building-management pilot.
-- Conventions:
--   * every table carries company_id; RLS isolates companies (see bottom of file)
--   * composite FKs (company_id, x_id) make cross-company references impossible
--   * money is integer agorot (*_agorot), timestamps are timestamptz
--   * enums are text + CHECK so they are cheap to change before the freeze

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tenancy

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- WhatsApp Cloud API phone-number id; inbound webhooks are routed by it
  wa_phone_number_id text unique,
  created_at timestamptz not null default now()
);

-- Maps Supabase Auth users (staff) to companies. Drives RLS.
create table company_members (
  company_id uuid not null references companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'admin' check (role in ('admin', 'maintenance_manager')),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index on company_members (user_id);

-- ---------------------------------------------------------------- buildings

create table buildings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  address text,
  fee_per_sqm_agorot integer not null check (fee_per_sqm_agorot >= 0),
  approval_threshold_agorot integer not null check (approval_threshold_agorot >= 0),
  bank_account_ref text,
  sla_critical_minutes integer not null default 30 check (sla_critical_minutes > 0),
  sla_high_minutes integer not null default 120 check (sla_high_minutes > 0),
  sla_normal_minutes integer not null default 2880 check (sla_normal_minutes > 0),
  auto_reminders_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, id)
);

create table units (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  building_id uuid not null,
  floor integer not null,
  number text not null,
  sqm numeric(7, 2) not null check (sqm > 0),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (building_id, number),
  foreign key (company_id, building_id) references buildings (company_id, id) on delete cascade
);

create table people (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  full_name text not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Locale for WhatsApp messages. Unsupported values fall back to the default in code.
  lang text not null default 'he' check (lang ~ '^[a-z]{2}$'),
  -- Set when the agent created this person from an unknown number
  needs_verification boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, phone_e164)
);

create table unit_roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  unit_id uuid not null,
  person_id uuid not null,
  role text not null check (role in ('owner', 'tenant', 'committee')),
  is_payer boolean not null default false,
  receives_updates boolean not null default true,
  created_at timestamptz not null default now(),
  unique (unit_id, person_id, role),
  foreign key (company_id, unit_id) references units (company_id, id) on delete cascade,
  foreign key (company_id, person_id) references people (company_id, id) on delete cascade
);
create unique index unit_roles_one_payer_per_unit on unit_roles (unit_id) where is_payer;
create index on unit_roles (person_id);

-- ---------------------------------------------------------------- vendors

create table vendors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  name text not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  lang text not null default 'he' check (lang ~ '^[a-z]{2}$'),
  categories text[] not null default '{}' check (
    categories <@ array['elevator', 'leak', 'common_electricity', 'tenant_club', 'door_or_code', 'cleaning', 'other']
  ),
  created_at timestamptz not null default now(),
  unique (company_id, id)
);

create table building_vendor_defaults (
  company_id uuid not null references companies (id),
  building_id uuid not null,
  category text not null check (
    category in ('elevator', 'leak', 'common_electricity', 'tenant_club', 'door_or_code', 'cleaning', 'other')
  ),
  vendor_id uuid not null,
  primary key (building_id, category),
  foreign key (company_id, building_id) references buildings (company_id, id) on delete cascade,
  foreign key (company_id, vendor_id) references vendors (company_id, id)
);

-- ---------------------------------------------------------------- tickets

create table tickets (
  id uuid primary key default gen_random_uuid(),
  -- Short human-facing number quoted to residents ("ticket #1042")
  number bigint generated always as identity (start with 1000) unique,
  company_id uuid not null references companies (id),
  building_id uuid not null,
  unit_id uuid, -- null = common area
  reporter_id uuid,
  category text not null check (
    category in ('elevator', 'leak', 'common_electricity', 'tenant_club', 'door_or_code', 'cleaning', 'other')
  ),
  urgency text not null default 'normal' check (urgency in ('critical', 'high', 'normal')),
  status text not null default 'open' check (
    status in ('open', 'dispatched', 'accepted', 'in_progress', 'awaiting_approval', 'resolved', 'closed', 'cancelled')
  ),
  title text not null,
  description text,
  location_text text,
  sla_due_at timestamptz,
  vendor_id uuid,
  cost_estimate_agorot integer check (cost_estimate_agorot >= 0),
  created_via text not null check (created_via in ('whatsapp', 'web', 'admin')),
  rating smallint check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (company_id, id),
  foreign key (company_id, building_id) references buildings (company_id, id),
  foreign key (company_id, unit_id) references units (company_id, id),
  foreign key (company_id, reporter_id) references people (company_id, id),
  foreign key (company_id, vendor_id) references vendors (company_id, id)
);
-- Dedup lookup and the ticket board
create index tickets_open_by_building on tickets (building_id, category, created_at desc)
  where status not in ('closed', 'cancelled');
create index tickets_sla_due on tickets (sla_due_at)
  where status not in ('resolved', 'closed', 'cancelled');

create table ticket_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  ticket_id uuid not null,
  type text not null,
  payload jsonb not null default '{}',
  actor_type text not null check (actor_type in ('system', 'agent', 'admin', 'resident', 'vendor', 'committee')),
  actor_id uuid, -- people.id, vendors.id or auth.users.id depending on actor_type
  created_at timestamptz not null default now(),
  foreign key (company_id, ticket_id) references tickets (company_id, id) on delete cascade
);
create index on ticket_events (ticket_id, created_at);

create table ticket_media (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  ticket_id uuid not null,
  storage_path text not null,
  mime_type text,
  wa_media_id text,
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  foreign key (company_id, ticket_id) references tickets (company_id, id) on delete cascade,
  foreign key (company_id, uploaded_by) references people (company_id, id)
);
create index on ticket_media (ticket_id);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  ticket_id uuid not null,
  amount_agorot integer not null check (amount_agorot >= 0),
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decision text check (decision in ('approved', 'rejected')),
  decided_at timestamptz,
  check ((decision is null) = (decided_at is null)),
  foreign key (company_id, ticket_id) references tickets (company_id, id) on delete cascade,
  foreign key (company_id, decided_by) references people (company_id, id)
);
create index on approvals (ticket_id);

-- ---------------------------------------------------------------- billing

create table charges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  building_id uuid not null,
  unit_id uuid not null,
  payer_id uuid,
  period date not null check (extract(day from period) = 1), -- first day of the billed month
  amount_agorot integer not null check (amount_agorot >= 0),
  due_date date not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (unit_id, period),
  foreign key (company_id, building_id) references buildings (company_id, id),
  foreign key (company_id, unit_id) references units (company_id, id),
  foreign key (company_id, payer_id) references people (company_id, id)
);
create index on charges (building_id, status, due_date);

create table payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  building_id uuid not null,
  -- Hash of the normalised bank row; makes re-importing the same CSV a no-op
  import_hash text not null,
  raw_row jsonb not null,
  amount_agorot integer not null,
  paid_at timestamptz not null,
  reference text,
  matched_charge_id uuid,
  status text not null default 'unmatched' check (status in ('unmatched', 'matched', 'ignored')),
  created_at timestamptz not null default now(),
  unique (building_id, import_hash),
  check ((status = 'matched') = (matched_charge_id is not null)),
  foreign key (company_id, building_id) references buildings (company_id, id),
  foreign key (company_id, matched_charge_id) references charges (company_id, id)
);
create index on payments (building_id, status);

create table reminders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  charge_id uuid not null,
  step smallint not null check (step between 1 and 4),
  sent_at timestamptz not null default now(),
  channel text not null default 'whatsapp',
  unique (charge_id, step),
  foreign key (company_id, charge_id) references charges (company_id, id) on delete cascade
);

-- ---------------------------------------------------------------- messaging

create table messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  direction text not null check (direction in ('in', 'out')),
  phone_e164 text not null,
  wa_message_id text unique, -- webhook idempotency key
  template text,
  body text,
  ticket_id uuid,
  status text not null default 'received' check (
    status in ('received', 'sent', 'blocked', 'dry_run', 'failed')
  ),
  created_at timestamptz not null default now(),
  foreign key (company_id, ticket_id) references tickets (company_id, id)
);
create index on messages (company_id, phone_e164, created_at desc);
create index on messages (ticket_id);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  phone_e164 text not null,
  state jsonb not null default '{}',
  last_inbound_at timestamptz, -- drives the WhatsApp 24h session window
  updated_at timestamptz not null default now(),
  unique (company_id, phone_e164)
);

-- ---------------------------------------------------------------- RLS

-- SECURITY DEFINER so policies on company_members itself do not recurse.
create function public.current_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select company_id from public.company_members where user_id = auth.uid()
$$;
revoke all on function public.current_company_ids() from public;
grant execute on function public.current_company_ids() to authenticated;

alter table companies enable row level security;
create policy companies_select on companies for select to authenticated
  using (id in (select public.current_company_ids()));

alter table company_members enable row level security;
create policy company_members_select on company_members for select to authenticated
  using (user_id = auth.uid());

do $$
declare
  t text;
begin
  foreach t in array array[
    'buildings', 'units', 'people', 'unit_roles', 'vendors', 'building_vendor_defaults',
    'tickets', 'ticket_events', 'ticket_media', 'approvals',
    'charges', 'payments', 'reminders', 'messages', 'conversations'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all to authenticated
         using (company_id in (select public.current_company_ids()))
         with check (company_id in (select public.current_company_ids()))',
      t || '_company_isolation', t
    );
  end loop;
end $$;

-- No policies for anon: residents never touch the database directly. The
-- WhatsApp webhook, the public report form and cron run server-side with the
-- service role, which bypasses RLS and must scope by company_id in code.
