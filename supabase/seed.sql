-- Fake data for local development: 1 company, 1 building, 20 units,
-- 20 residents (2 on the committee), 3 vendors. All phone numbers are fake.

insert into companies (id, name, wa_phone_number_id) values
  ('00000000-0000-4000-8000-000000000001', 'Demo Management Ltd', 'DEV_PHONE_NUMBER_ID');

insert into buildings (id, company_id, name, slug, address, fee_per_sqm_agorot, approval_threshold_agorot, bank_account_ref) values
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001',
   'Demo Tower', 'demo-tower', '1 Example St, Tel Aviv', 650, 150000, 'DEMO-BANK-12-345-678901');

-- 5 floors x 4 units, 60-105 sqm
insert into units (company_id, building_id, floor, number, sqm)
select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000010',
       (n - 1) / 4 + 1, n::text, 60 + ((n - 1) % 4) * 15
from generate_series(1, 20) as n;

insert into people (company_id, full_name, phone_e164, lang)
select '00000000-0000-4000-8000-000000000001', 'Resident ' || n,
       '+97250000' || lpad(n::text, 4, '0'), case when n % 5 = 0 then 'en' else 'he' end
from generate_series(1, 20) as n;

-- Resident N lives in unit N; odd units are owner-occupied, even are rented.
insert into unit_roles (company_id, unit_id, person_id, role, is_payer)
select u.company_id, u.id, p.id,
       case when u.number::int % 2 = 1 then 'owner' else 'tenant' end, true
from units u
join people p on p.company_id = u.company_id and p.full_name = 'Resident ' || u.number;

-- Residents 1 and 3 are also on the building committee.
insert into unit_roles (company_id, unit_id, person_id, role)
select u.company_id, u.id, p.id, 'committee'
from units u
join people p on p.company_id = u.company_id and p.full_name = 'Resident ' || u.number
where u.number in ('1', '3');

insert into vendors (id, company_id, name, phone_e164, categories) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'Demo Elevators', '+972500009001', '{elevator}'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001', 'Demo Plumbing & Electric', '+972500009002', '{leak,common_electricity}'),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000001', 'Demo Maintenance', '+972500009003', '{cleaning,door_or_code,tenant_club,other}');

insert into building_vendor_defaults (company_id, building_id, category, vendor_id)
select v.company_id, '00000000-0000-4000-8000-000000000010', c, v.id
from vendors v, unnest(v.categories) as c;
