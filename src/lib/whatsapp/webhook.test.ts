import { describe, expect, it } from "vitest";
import { catalogs } from "@/i18n/messages";
import { mayMessage, sendText } from "./client";
import { webhookPayload } from "./schema";
import { sign, verifySignature } from "./signature";
import { handleWebhook, type InboundRow, type OutboundRow, type WebhookDeps } from "./webhook";

const PHONE_NUMBER_ID = "PNID";
const COMPANY_ID = "company-1";

function payload(messages: unknown[], phoneNumberId = PHONE_NUMBER_ID) {
  return webhookPayload.parse({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, messages } }],
      },
    ],
  });
}

const text = (id: string, body: string, from = "972500000001") => ({
  id,
  from,
  timestamp: "1794000000",
  type: "text",
  text: { body },
});

function fakeDeps(langByPhone: Record<string, string> = {}) {
  const inbound: InboundRow[] = [];
  const outbound: OutboundRow[] = [];
  const sent: { to: string; body: string }[] = [];
  const touched: string[] = [];
  const deps: WebhookDeps = {
    findCompanyIdByPhoneNumberId: async (id) => (id === PHONE_NUMBER_ID ? COMPANY_ID : null),
    insertInbound: async (row) => {
      if (inbound.some((r) => r.waMessageId === row.waMessageId)) return false;
      inbound.push(row);
      return true;
    },
    touchConversation: async (_c, phone) => void touched.push(phone),
    findPersonLang: async (_c, phone) => langByPhone[phone] ?? null,
    insertOutbound: async (row) => void outbound.push(row),
    sendText: async ({ to, body }) => {
      sent.push({ to, body });
      return { status: "sent", waMessageId: `out-${sent.length}` };
    },
  };
  return { deps, inbound, outbound, sent, touched };
}

describe("handleWebhook", () => {
  it("stores the inbound message and echoes in the default locale", async () => {
    const f = fakeDeps();
    const summary = await handleWebhook(payload([text("wamid.1", "hello")]), f.deps);

    expect(summary).toEqual({ received: 1, duplicates: 0, replied: 1 });
    expect(f.inbound).toEqual([
      { companyId: COMPANY_ID, phone: "+972500000001", waMessageId: "wamid.1", body: "hello" },
    ]);
    expect(f.touched).toEqual(["+972500000001"]);
    expect(f.sent[0].to).toBe("+972500000001");
    expect(f.sent[0].body).toBe(catalogs.he.whatsapp.echo.replace("{text}", "hello"));
    expect(f.outbound[0]).toMatchObject({ status: "sent", waMessageId: "out-1", companyId: COMPANY_ID });
  });

  it("replies in the person's stored language", async () => {
    const f = fakeDeps({ "+972500000001": "en" });
    await handleWebhook(payload([text("wamid.1", "hello")]), f.deps);
    expect(f.sent[0].body).toBe("We received your message: hello");
  });

  it("is idempotent on wa_message_id", async () => {
    const f = fakeDeps();
    const p = payload([text("wamid.1", "hello")]);
    await handleWebhook(p, f.deps);
    const second = await handleWebhook(p, f.deps);

    expect(second).toEqual({ received: 1, duplicates: 1, replied: 0 });
    expect(f.inbound).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
  });

  it("ignores phone-number ids that belong to no company", async () => {
    const f = fakeDeps();
    const summary = await handleWebhook(payload([text("wamid.1", "hello")], "UNKNOWN"), f.deps);
    expect(summary.received).toBe(0);
    expect(f.inbound).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });

  it("answers unsupported message types without echoing", async () => {
    const f = fakeDeps({ "+972500000001": "en" });
    await handleWebhook(
      payload([{ id: "wamid.2", from: "972500000001", timestamp: "1794000000", type: "audio" }]),
      f.deps,
    );
    expect(f.inbound[0].body).toBeNull();
    expect(f.sent[0].body).toBe(catalogs.en.whatsapp.unsupportedMessageType);
  });

  it("accepts status-only webhooks (no messages)", async () => {
    const f = fakeDeps();
    const statusOnly = webhookPayload.parse({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            { field: "messages", value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, statuses: [{}] } },
          ],
        },
      ],
    });
    expect(await handleWebhook(statusOnly, f.deps)).toEqual({ received: 0, duplicates: 0, replied: 0 });
  });
});

describe("verifySignature", () => {
  const body = JSON.stringify({ hello: "world" });
  it("accepts a correct signature", () => {
    expect(verifySignature(body, sign(body, "secret"), "secret")).toBe(true);
  });
  it("rejects a wrong secret, a tampered body, and missing or malformed headers", () => {
    expect(verifySignature(body, sign(body, "other"), "secret")).toBe(false);
    expect(verifySignature(body + " ", sign(body, "secret"), "secret")).toBe(false);
    expect(verifySignature(body, null, "secret")).toBe(false);
    expect(verifySignature(body, "sha256=zz", "secret")).toBe(false);
    expect(verifySignature(body, "sha1=abc", "secret")).toBe(false);
  });
});

describe("outbound dev safety", () => {
  const base = { accessToken: "token", graphVersion: "v23.0" };
  const args = { phoneNumberId: "PNID", to: "+972500000001", body: "hi" };
  const neverFetch: typeof fetch = async () => {
    throw new Error("must not be called");
  };

  it("allows only allowlisted numbers unless WA_LIVE is exactly 'true'", () => {
    expect(mayMessage("+972500000001", { allowlist: "+972500000002, +972500000001", live: "false" })).toBe(true);
    expect(mayMessage("+972500000003", { allowlist: "+972500000001", live: "false" })).toBe(false);
    expect(mayMessage("+972500000003", { allowlist: "", live: "TRUE" })).toBe(false);
    expect(mayMessage("+972500000003", { allowlist: "", live: "true" })).toBe(true);
  });

  it("does not call the API for a blocked number", async () => {
    const result = await sendText(args, { ...base, allowlist: "", live: "false" }, neverFetch);
    expect(result.status).toBe("blocked");
  });

  it("dry-runs without an access token", async () => {
    const result = await sendText(args, { graphVersion: "v23.0", allowlist: args.to, live: "false" }, neverFetch);
    expect(result.status).toBe("dry_run");
  });

  it("sends to an allowlisted number and returns the message id", async () => {
    let request: { url: string; body: { to: string } } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      request = { url, body: JSON.parse(init.body as string) };
      return Response.json({ messages: [{ id: "wamid.out" }] });
    }) as typeof fetch;
    const result = await sendText(args, { ...base, allowlist: args.to, live: "false" }, fakeFetch);

    expect(result).toEqual({ status: "sent", waMessageId: "wamid.out" });
    expect(request?.url).toBe("https://graph.facebook.com/v23.0/PNID/messages");
    expect(request?.body.to).toBe("972500000001");
  });

  it("reports failure on a non-2xx response", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 400 })) as typeof fetch;
    const result = await sendText(args, { ...base, allowlist: args.to, live: "false" }, fakeFetch);
    expect(result.status).toBe("failed");
  });
});
