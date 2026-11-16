import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendText } from "./client";
import type { WebhookDeps } from "./webhook";

function check(error: { message: string } | null): void {
  if (error) throw new Error(`supabase: ${error.message}`);
}

/** Production wiring of the webhook: Supabase (service role) + the Cloud API. */
export function productionDeps(): WebhookDeps {
  const db = supabaseAdmin();
  return {
    async findCompanyIdByPhoneNumberId(phoneNumberId) {
      const { data, error } = await db
        .from("companies")
        .select("id")
        .eq("wa_phone_number_id", phoneNumberId)
        .maybeSingle();
      check(error);
      return data?.id ?? null;
    },

    async insertInbound(row) {
      const { data, error } = await db
        .from("messages")
        .upsert(
          {
            company_id: row.companyId,
            direction: "in",
            phone_e164: row.phone,
            wa_message_id: row.waMessageId,
            body: row.body,
            status: "received",
          },
          { onConflict: "wa_message_id", ignoreDuplicates: true },
        )
        .select("id");
      check(error);
      return (data?.length ?? 0) > 0;
    },

    async touchConversation(companyId, phone, at) {
      const { error } = await db.from("conversations").upsert(
        {
          company_id: companyId,
          phone_e164: phone,
          last_inbound_at: at.toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "company_id,phone_e164" },
      );
      check(error);
    },

    async findPersonLang(companyId, phone) {
      const { data, error } = await db
        .from("people")
        .select("lang")
        .eq("company_id", companyId)
        .eq("phone_e164", phone)
        .maybeSingle();
      check(error);
      return data?.lang ?? null;
    },

    async insertOutbound(row) {
      const { error } = await db.from("messages").insert({
        company_id: row.companyId,
        direction: "out",
        phone_e164: row.phone,
        wa_message_id: row.waMessageId,
        body: row.body,
        status: row.status,
      });
      check(error);
    },

    sendText(args) {
      const e = env();
      return sendText(args, {
        accessToken: e.WA_ACCESS_TOKEN,
        graphVersion: e.WA_GRAPH_VERSION,
        allowlist: e.WA_ALLOWLIST,
        live: e.WA_LIVE,
      });
    },
  };
}
