-- Tenant-isolation smoke test. Run after migrations + seed:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql
-- Everything runs in a transaction that is rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-4000-8000-0000000000a1'), ('00000000-0000-4000-8000-0000000000b1');
insert into companies (id, name) values ('00000000-0000-4000-8000-000000000002', 'Other Co');
insert into buildings (company_id, name, slug, fee_per_sqm_agorot, approval_threshold_agorot)
  values ('00000000-0000-4000-8000-000000000002', 'Other Building', 'other-building', 500, 100000);
insert into company_members (company_id, user_id) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000b1');

set local role authenticated;

-- User A (Demo company)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1"}', true);
do $$
begin
  assert (select count(*) from buildings) = 1, 'A sees exactly its own building';
  assert (select count(*) from units) = 20, 'A sees its 20 units';
  assert (select count(*) from people) = 20, 'A sees its 20 people';
  assert (select count(*) from companies) = 1, 'A sees only its company';
  begin
    insert into people (company_id, full_name, phone_e164)
      values ('00000000-0000-4000-8000-000000000002', 'Intruder', '+972500000999');
    raise exception 'A must not insert into company B';
  exception when insufficient_privilege then null;
  end;
end $$;

-- User B (Other company)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1"}', true);
do $$
begin
  assert (select count(*) from buildings) = 1, 'B sees exactly its own building';
  assert (select slug from buildings) = 'other-building', 'B sees the right building';
  assert (select count(*) from units) = 0, 'B sees no units of A';
  assert (select count(*) from people) = 0, 'B sees no people of A';
  assert (select count(*) from vendors) = 0, 'B sees no vendors of A';
end $$;

-- Not a member of anything
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1"}', true);
do $$
begin
  assert (select count(*) from buildings) = 0, 'stranger sees nothing';
  assert (select count(*) from companies) = 0, 'stranger sees no company';
end $$;

reset role;

-- Cross-company references are rejected even for the service role.
do $$
begin
  begin
    insert into units (company_id, building_id, floor, number, sqm)
      values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000010', 1, 'x', 50);
    raise exception 'cross-company unit must be rejected';
  exception when foreign_key_violation then null;
  end;
end $$;

rollback;
\echo 'RLS isolation: OK'
