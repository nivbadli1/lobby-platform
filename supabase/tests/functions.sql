-- Tests for the import functions and the inbound-message claim. Run after migrations + seed:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/functions.sql
begin;

insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000a1'), ('00000000-0000-4000-8000-0000000000b1');
insert into companies (id, name) values ('00000000-0000-4000-8000-000000000002', 'Other Co');
insert into company_members (company_id, user_id) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000b1');

-- ---- claim_inbound_message (service role)
insert into messages (company_id, direction, phone_e164, wa_message_id, body)
  values ('00000000-0000-4000-8000-000000000001', 'in', '+972500000001', 'wamid.T1', 'hi');
do $$
declare c uuid := '00000000-0000-4000-8000-000000000001';
begin
  assert claim_inbound_message(c, 'wamid.nope') = 'missing';
  assert claim_inbound_message(c, 'wamid.T1') = 'claimed';
  assert claim_inbound_message(c, 'wamid.T1') = 'in_flight', 'fresh claim blocks a second worker';
  update messages set claimed_at = null where wa_message_id = 'wamid.T1'; -- released after a failure
  assert claim_inbound_message(c, 'wamid.T1') = 'claimed';
  update messages set claimed_at = now() - interval '10 minutes' where wa_message_id = 'wamid.T1';
  assert claim_inbound_message(c, 'wamid.T1') = 'claimed', 'stale claim (crashed worker) can be retaken';
  assert (select attempts from messages where wa_message_id = 'wamid.T1') = 3;
  update messages set claimed_at = null, attempts = 5 where wa_message_id = 'wamid.T1';
  assert claim_inbound_message(c, 'wamid.T1') = 'exhausted';
  update messages set processed_at = now() where wa_message_id = 'wamid.T1';
  assert claim_inbound_message(c, 'wamid.T1') = 'done';
  assert claim_inbound_message('00000000-0000-4000-8000-000000000002', 'wamid.T1') = 'missing', 'scoped by company';
end $$;

-- ---- imports, as staff user A of the Demo company
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1"}', true);
do $$
declare
  b uuid := '00000000-0000-4000-8000-000000000010';
  n integer;
begin
  -- units: update one, add one
  n := import_units(b, '[{"floor": 1, "number": "1", "sqm": 61.5}, {"floor": 6, "number": "21", "sqm": 120}]');
  assert n = 2;
  assert (select count(*) from units) = 21;
  assert (select sqm from units where number = '1') = 61.5;

  -- people: new owner becomes payer of unit 2 (replacing the seeded tenant), plus a committee role
  n := import_people(b, '[
    {"full_name": "Dana Levi", "phone_e164": "+972520000001", "lang": "he", "unit_number": "2", "role": "owner", "is_payer": true},
    {"full_name": "Dana Levi", "phone_e164": "+972520000001", "lang": "he", "unit_number": "2", "role": "committee", "is_payer": false},
    {"full_name": "Resident One Renamed", "phone_e164": "+972500000001", "lang": "en", "unit_number": "1", "role": "owner", "is_payer": true}
  ]');
  assert n = 3;
  assert (select count(*) from people) = 21, 'one new person, one updated';
  assert (select full_name from people where phone_e164 = '+972500000001') = 'Resident One Renamed';
  assert (select count(*) from unit_roles ur join units u on u.id = ur.unit_id where u.number = '2' and ur.is_payer) = 1;
  assert (select p.full_name from unit_roles ur join units u on u.id = ur.unit_id join people p on p.id = ur.person_id
          where u.number = '2' and ur.is_payer) = 'Dana Levi';
  -- re-running is a no-op
  perform import_people(b, '[{"full_name": "Dana Levi", "phone_e164": "+972520000001", "lang": "he", "unit_number": "2", "role": "owner", "is_payer": true}]');
  assert (select count(*) from people) = 21;

  -- unknown unit aborts the whole import
  begin
    perform import_people(b, '[
      {"full_name": "X", "phone_e164": "+972520000009", "unit_number": "1", "role": "tenant", "is_payer": false},
      {"full_name": "Y", "phone_e164": "+972520000008", "unit_number": "999", "role": "tenant", "is_payer": false}]');
    raise exception 'expected failure';
  exception when raise_exception then
    assert sqlerrm = 'unknown units: 999', sqlerrm;
  end;
  assert (select count(*) from people where phone_e164 = '+972520000009') = 0, 'nothing partially imported';

  -- vendors: existing vendor gains a category and takes over as default; new vendor is not default
  n := import_vendors(b, '[
    {"name": "Demo Elevators", "phone_e164": "+972500009001", "categories": ["elevator", "door_or_code"], "is_default": true},
    {"name": "Backup Plumber", "phone_e164": "+972500009009", "categories": ["leak"], "is_default": false}]');
  assert n = 2;
  assert (select count(*) from vendors) = 4;
  assert (select categories from vendors where phone_e164 = '+972500009001') = '{door_or_code,elevator}';
  assert (select v.name from building_vendor_defaults d join vendors v on v.id = d.vendor_id where d.category = 'door_or_code') = 'Demo Elevators';
  assert (select v.name from building_vendor_defaults d join vendors v on v.id = d.vendor_id where d.category = 'leak') = 'Demo Plumbing & Electric';
end $$;

-- ---- user B cannot import into company A's building, nor claim messages
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1"}', true);
do $$
begin
  begin
    perform import_units('00000000-0000-4000-8000-000000000010', '[{"floor": 1, "number": "66", "sqm": 50}]');
    raise exception 'expected failure';
  exception when raise_exception then
    assert sqlerrm = 'building not found', sqlerrm;
  end;
  begin
    perform claim_inbound_message('00000000-0000-4000-8000-000000000001', 'wamid.T1');
    raise exception 'expected failure';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
\echo 'functions: OK'
