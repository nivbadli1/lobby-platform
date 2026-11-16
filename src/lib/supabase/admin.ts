import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

let client: SupabaseClient | undefined;

/**
 * Service-role client for server-only code (webhooks, cron, the public report
 * form). It bypasses RLS: every query MUST filter by company_id explicitly.
 */
export function supabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(env().NEXT_PUBLIC_SUPABASE_URL, env().SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
