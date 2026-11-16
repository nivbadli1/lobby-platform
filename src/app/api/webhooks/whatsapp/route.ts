import { env } from "@/lib/env";
import { productionDeps } from "@/lib/whatsapp/deps";
import { webhookPayload } from "@/lib/whatsapp/schema";
import { verifySignature } from "@/lib/whatsapp/signature";
import { handleWebhook } from "@/lib/whatsapp/webhook";

/** Meta's one-time subscription handshake. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const ok =
    params.get("hub.mode") === "subscribe" && params.get("hub.verify_token") === env().WA_VERIFY_TOKEN;
  if (!ok) return new Response("Forbidden", { status: 403 });
  return new Response(params.get("hub.challenge") ?? "", { status: 200 });
}

export async function POST(request: Request) {
  // The signature covers the exact bytes Meta sent, so read the raw body first.
  const rawBody = await request.text();
  if (!verifySignature(rawBody, request.headers.get("x-hub-signature-256"), env().WA_APP_SECRET)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const parsed = webhookPayload.safeParse(json);
  if (!parsed.success) {
    // Signed by Meta but a shape we do not handle: acknowledge so it is not retried.
    console.warn("[wa] unrecognised webhook payload shape");
    return Response.json({ ok: true });
  }

  // A thrown error returns 500 and Meta retries. Dedupe prevents double-processing, but a
  // message that was stored and then failed is not reprocessed (revisit with the agent, day 3).
  const summary = await handleWebhook(parsed.data, productionDeps());
  return Response.json({ ok: true, ...summary });
}
