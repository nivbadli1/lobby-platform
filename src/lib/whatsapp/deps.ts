import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendText } from "./client";
import type { ClaimResult, WebhookDeps } from "./webhook";

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
      const { error } = await db.from("messages").upsert(
        {
          company_id: row.companyId,
          direction: "in",
          phone_e164: row.phone,
          wa_message_id: row.waMessageId,
          body: row.body,
          status: "received",
        },
        { onConflict: "wa_message_id", ignoreDuplicates: true },
      );
      check(error);
    },

    async claimInbound(companyId, waMessageId) {
      const { data, error } = await db.rpc("claim_inbound_message", {
        p_company_id: companyId,
        p_wa_message_id: waMessageId,
      });
      check(error);
      return data as ClaimResult;
    },

    async markProcessed(companyId, waMessageId) {
      const { error } = await db
        .from("messages")
        .update({ processed_at: new Date().toISOString(), claimed_at: null })
        .eq("company_id", companyId)
        .eq("wa_message_id", waMessageId);
      check(error);
    },

    async releaseClaim(companyId, waMessageId) {
      const { error } = await db
        .from("messages")
        .update({ claimed_at: null })
        .eq("company_id", companyId)
        .eq("wa_message_id", waMessageId);
      check(error);
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
