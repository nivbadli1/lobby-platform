// Creates a staff login and links it to a company (creating the company if needed).
//
//   node --env-file=.env.local scripts/create-admin.mjs <email> <password> "<company name>"
//
// Uses the service-role key, so run it only from a trusted machine.
import { createClient } from "@supabase/supabase-js";

const [email, password, companyName] = process.argv.slice(2);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!email || !password || !companyName || !url || !key) {
  console.error('Usage: node --env-file=.env.local scripts/create-admin.mjs <email> <password> "<company name>"');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });
const fail = (step, error) => {
  console.error(`${step} failed: ${error.message}`);
  process.exit(1);
};

let { data: company, error } = await db.from("companies").select("id").eq("name", companyName).maybeSingle();
if (error) fail("Company lookup", error);
if (!company) {
  ({ data: company, error } = await db.from("companies").insert({ name: companyName }).select("id").single());
  if (error) fail("Company creation", error);
  console.log(`Created company "${companyName}"`);
}

const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
if (created.error) fail("User creation", created.error);

const member = await db.from("company_members").insert({ company_id: company.id, user_id: created.data.user.id, role: "admin" });
if (member.error) fail("Membership", member.error);

console.log(`Admin ${email} can now sign in to "${companyName}" (company id ${company.id}).`);
