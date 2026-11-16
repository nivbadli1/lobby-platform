import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function supabasePublicConfig(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set");
  return { url, anonKey };
}

/**
 * Supabase client acting as the signed-in staff user. RLS applies, so queries
 * only ever see the user's own company. Create one per request.
 */
export async function supabaseServer() {
  const cookieStore = await cookies();
  const { url, anonKey } = supabasePublicConfig();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot write cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}

export type StaffContext = { userId: string; companyId: string | null };

/** The signed-in user and their company, or null if not signed in. */
export async function getStaff(): Promise<StaffContext | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  // Pilot assumption: a staff user belongs to one company.
  const { data: member } = await supabase
    .from("company_members")
    .select("company_id")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  return { userId: data.user.id, companyId: member?.company_id ?? null };
}
