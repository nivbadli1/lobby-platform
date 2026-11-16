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
  /** Stores the message unless its wa_message_id already exists (Meta redelivers). */
  insertInbound(row: InboundRow): Promise<void>;
  /** Atomically takes the message for processing; see claim_inbound_message in the schema. */
  claimInbound(companyId: string, waMessageId: string): Promise<ClaimResult>;
  markProcessed(companyId: string, waMessageId: string): Promise<void>;
  /** Gives the claim back after a failure so the next delivery can retry at once. */
  releaseClaim(companyId: string, waMessageId: string): Promise<void>;
  touchConversation(companyId: string, phone: string, at: Date): Promise<void>;
  findPersonLang(companyId: string, phone: string): Promise<string | null>;
  insertOutbound(row: OutboundRow): Promise<void>;
  sendText(args: { phoneNumberId: string; to: string; body: string }): Promise<SendResult>;
};

export type ClaimResult = "claimed" | "done" | "in_flight" | "exhausted" | "missing";

export type WebhookSummary = {
  received: number;
  duplicates: number;
  replied: number;
  /** True when a message could not be completed; the route answers 500 so Meta redelivers. */
  retry: boolean;
};

function textOf(message: WaMessage): string | null {
  return (
    message.text?.body ??
    message.image?.caption ??
    message.interactive?.button_reply?.title ??
    message.button?.text ??
    null
  );
}

/** Handles one claimed message. Throws if it could not be completed. */
async function processMessage(
  deps: WebhookDeps,
  ctx: { companyId: string; phoneNumberId: string; phone: string; text: string | null },
): Promise<SendResult["status"]> {
  // Day-1 behaviour: echo. The Claude agent replaces this reply on day 3.
  const t = getTranslator(await deps.findPersonLang(ctx.companyId, ctx.phone));
  const body = ctx.text ? t("whatsapp.echo", { text: ctx.text }) : t("whatsapp.unsupportedMessageType");
  const result = await deps.sendText({ phoneNumberId: ctx.phoneNumberId, to: ctx.phone, body });
  await deps.insertOutbound({
    companyId: ctx.companyId,
    phone: ctx.phone,
    waMessageId: result.waMessageId ?? null,
    body,
    status: result.status,
  });
  // "blocked" and "dry_run" are deliberate outcomes; only a failed send is retried.
  if (result.status === "failed") throw new Error("reply could not be sent");
  return result.status;
}

/**
 * Delivery is at-least-once: each inbound message is stored once, claimed, and
 * marked processed only after its reply went out. A failure releases the claim
 * and reports `retry`, so Meta's redelivery picks it up again (up to the
 * attempt cap). The rare cost is a duplicate reply if marking processed fails.
 */
export async function handleWebhook(payload: WebhookPayload, deps: WebhookDeps): Promise<WebhookSummary> {
  const summary: WebhookSummary = { received: 0, duplicates: 0, replied: 0, retry: false };

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
        await deps.insertInbound({ companyId, phone, waMessageId: message.id, body: text });

        const claim = await deps.claimInbound(companyId, message.id);
        if (claim !== "claimed") {
          summary.duplicates++;
          if (claim === "in_flight") summary.retry = true;
          if (claim === "exhausted") console.error(`[wa] giving up on message ${message.id}: attempts exhausted`);
          continue;
        }

        try {
          await deps.touchConversation(companyId, phone, new Date(Number(message.timestamp) * 1000));
          const status = await processMessage(deps, { companyId, phoneNumberId, phone, text });
          await deps.markProcessed(companyId, message.id);
          if (status === "sent") summary.replied++;
          console.info(`[wa] inbound from ${maskPhone(phone)} -> reply ${status}`);
        } catch (err) {
          summary.retry = true;
          console.error(`[wa] processing ${message.id} failed: ${err instanceof Error ? err.message : "unknown"}`);
          await deps.releaseClaim(companyId, message.id).catch(() => {});
        }
      }
    }
  }
  return summary;
}
