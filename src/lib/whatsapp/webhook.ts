import { getTranslator } from "@/i18n/translator";
import { maskPhone, toE164 } from "@/lib/phone";
import type { SendResult } from "./client";
import type { WaMessage, WebhookPayload } from "./schema";

export type InboundRow = {
  companyId: string;
  phone: string;
  waMessageId: string;
  body: string | null;
};

export type OutboundRow = {
  companyId: string;
  phone: string;
  waMessageId: string | null;
  body: string;
  status: SendResult["status"];
};

/** Everything the webhook needs from the outside world; faked in tests. */
export type WebhookDeps = {
  findCompanyIdByPhoneNumberId(phoneNumberId: string): Promise<string | null>;
  /** Returns false if this wa_message_id was already stored (Meta retries deliveries). */
  insertInbound(row: InboundRow): Promise<boolean>;
  touchConversation(companyId: string, phone: string, at: Date): Promise<void>;
  findPersonLang(companyId: string, phone: string): Promise<string | null>;
  insertOutbound(row: OutboundRow): Promise<void>;
  sendText(args: { phoneNumberId: string; to: string; body: string }): Promise<SendResult>;
};

export type WebhookSummary = { received: number; duplicates: number; replied: number };

function textOf(message: WaMessage): string | null {
  return (
    message.text?.body ??
    message.image?.caption ??
    message.interactive?.button_reply?.title ??
    message.button?.text ??
    null
  );
}

export async function handleWebhook(payload: WebhookPayload, deps: WebhookDeps): Promise<WebhookSummary> {
  const summary: WebhookSummary = { received: 0, duplicates: 0, replied: 0 };

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata?.phone_number_id;
      const messages = change.value.messages ?? [];
      if (change.field !== "messages" || !phoneNumberId || messages.length === 0) continue;

      const companyId = await deps.findCompanyIdByPhoneNumberId(phoneNumberId);
      if (!companyId) {
        console.warn(`[wa] no company for phone_number_id ${phoneNumberId}; ignoring`);
        continue;
      }

      for (const message of messages) {
        const phone = toE164(message.from);
        if (!phone) continue;
        summary.received++;

        const text = textOf(message);
        const isNew = await deps.insertInbound({ companyId, phone, waMessageId: message.id, body: text });
        if (!isNew) {
          summary.duplicates++;
          continue;
        }
        await deps.touchConversation(companyId, phone, new Date(Number(message.timestamp) * 1000));

        // Day-1 behaviour: echo. The Claude agent replaces this reply on day 3.
        const t = getTranslator(await deps.findPersonLang(companyId, phone));
        const body = text ? t("whatsapp.echo", { text }) : t("whatsapp.unsupportedMessageType");
        const result = await deps.sendText({ phoneNumberId, to: phone, body });
        await deps.insertOutbound({
          companyId,
          phone,
          waMessageId: result.waMessageId ?? null,
          body,
          status: result.status,
        });
        if (result.status === "sent") summary.replied++;
        console.info(`[wa] inbound from ${maskPhone(phone)} -> reply ${result.status}`);
      }
    }
  }
  return summary;
}
