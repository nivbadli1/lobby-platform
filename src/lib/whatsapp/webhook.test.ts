import { describe, expect, it } from "vitest";
import { catalogs } from "@/i18n/messages";
import { mayMessage, sendText, type SendStatus } from "./client";
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

type Stored = InboundRow & { processed: boolean; claimed: boolean; attempts: number };

function fakeDeps(langByPhone: Record<string, string> = {}) {
  const inbound: Stored[] = [];
  const outbound: OutboundRow[] = [];
  const sent: { to: string; body: string }[] = [];
  const touched: string[] = [];
  const control = { sendStatus: "sent" as SendStatus, maxAttempts: 5 };
  const find = (id: string) => inbound.find((r) => r.waMessageId === id);
  const deps: WebhookDeps = {
    findCompanyIdByPhoneNumberId: async (id) => (id === PHONE_NUMBER_ID ? COMPANY_ID : null),
    insertInbound: async (row) => {
      if (!find(row.waMessageId)) inbound.push({ ...row, processed: false, claimed: false, attempts: 0 });
    },
    claimInbound: async (_c, id) => {
      const m = find(id);
      if (!m) return "missing";
      if (m.processed) return "done";
      if (m.claimed) return "in_flight";
      if (m.attempts >= control.maxAttempts) return "exhausted";
      m.claimed = true;
      m.attempts++;
      return "claimed";
    },
    markProcessed: async (_c, id) => {
      Object.assign(find(id)!, { processed: true, claimed: false });
    },
    releaseClaim: async (_c, id) => {
      find(id)!.claimed = false;
    },
    touchConversation: async (_c, phone) => void touched.push(phone),
    findPersonLang: async (_c, phone) => langByPhone[phone] ?? null,
    insertOutbound: async (row) => void outbound.push(row),
    sendText: async ({ to, body }) => {
      sent.push({ to, body });
      return control.sendStatus === "sent"
        ? { status: "sent", waMessageId: `out-${sent.length}` }
        : { status: control.sendStatus };
    },
  };
  return { deps, inbound, outbound, sent, touched, control };
}

describe("handleWebhook", () => {
  it("stores the inbound message and echoes in the default locale", async () => {
    const f = fakeDeps();
    const summary = await handleWebhook(payload([text("wamid.1", "hello")]), f.deps);

    expect(summary).toEqual({ received: 1, duplicates: 0, replied: 1, retry: false });
    expect(f.inbound).toEqual([
      {
        companyId: COMPANY_ID,
        phone: "+972500000001",
        waMessageId: "wamid.1",
        body: "hello",
        processed: true,
        claimed: false,
        attempts: 1,
      },
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

    expect(second).toEqual({ received: 1, duplicates: 1, replied: 0, retry: false });
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
    expect(await handleWebhook(statusOnly, f.deps)).toEqual({
      received: 0,
      duplicates: 0,
      replied: 0,
      retry: false,
    });
  });

  it("asks for redelivery when the reply fails, then completes on the retry", async () => {
    const f = fakeDeps();
    const p = payload([text("wamid.1", "hello")]);
    f.control.sendStatus = "failed";
    const first = await handleWebhook(p, f.deps);
    expect(first).toMatchObject({ retry: true, replied: 0 });
    expect(f.inbound[0]).toMatchObject({ processed: false, claimed: false, attempts: 1 });

    f.control.sendStatus = "sent";
    const second = await handleWebhook(p, f.deps);
    expect(second).toMatchObject({ retry: false, replied: 1, duplicates: 0 });
    expect(f.inbound).toHaveLength(1);
    expect(f.inbound[0]).toMatchObject({ processed: true, attempts: 2 });
    expect(f.outbound.map((o) => o.status)).toEqual(["failed", "sent"]);
  });

  it("releases the claim and asks for redelivery when a dependency throws", async () => {
    const f = fakeDeps();
    f.deps.findPersonLang = async () => {
      throw new Error("db down");
    };
    const summary = await handleWebhook(payload([text("wamid.1", "hello")]), f.deps);
    expect(summary.retry).toBe(true);
    expect(f.inbound[0]).toMatchObject({ processed: false, claimed: false });
  });

  it("one failing message does not block the others in the batch", async () => {
    const f = fakeDeps();
    const send = f.deps.sendText;
    f.deps.sendText = async (args) => (args.body.includes("bad") ? { status: "failed" } : send(args));
    const summary = await handleWebhook(payload([text("wamid.1", "bad"), text("wamid.2", "good")]), f.deps);
    expect(summary).toMatchObject({ received: 2, replied: 1, retry: true });
    expect(f.inbound.map((m) => m.processed)).toEqual([false, true]);
  });

  it("asks for redelivery while another invocation holds the claim", async () => {
    const f = fakeDeps();
    await f.deps.insertInbound({ companyId: COMPANY_ID, phone: "+972500000001", waMessageId: "wamid.1", body: "x" });
    await f.deps.claimInbound(COMPANY_ID, "wamid.1");
    const summary = await handleWebhook(payload([text("wamid.1", "x")]), f.deps);
    expect(summary).toMatchObject({ duplicates: 1, retry: true });
    expect(f.sent).toHaveLength(0);
  });

  it("stops retrying after the attempt cap", async () => {
    const f = fakeDeps();
    f.control.sendStatus = "failed";
    const p = payload([text("wamid.1", "hello")]);
    for (let i = 0; i < 5; i++) await handleWebhook(p, f.deps);
    const sixth = await handleWebhook(p, f.deps);
    expect(sixth).toMatchObject({ retry: false, duplicates: 1 });
    expect(f.sent).toHaveLength(5);
  });

  it("treats allowlist-blocked and dry-run replies as processed", async () => {
    for (const status of ["blocked", "dry_run"] as const) {
      const f = fakeDeps();
      f.control.sendStatus = status;
      const summary = await handleWebhook(payload([text("wamid.1", "hello")]), f.deps);
      expect(summary).toMatchObject({ retry: false, replied: 0 });
      expect(f.inbound[0].processed).toBe(true);
    }
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
