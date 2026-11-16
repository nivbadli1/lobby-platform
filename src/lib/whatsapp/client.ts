import { maskPhone } from "@/lib/phone";

export type SendStatus = "sent" | "blocked" | "dry_run" | "failed";
export type SendResult = { status: SendStatus; waMessageId?: string };

export type WaConfig = {
  accessToken?: string;
  graphVersion: string;
  allowlist: string;
  live: string;
};

/** Dev safety: unless WA_LIVE is exactly "true", only allowlisted numbers get messages. */
export function mayMessage(phoneE164: string, config: Pick<WaConfig, "allowlist" | "live">): boolean {
  if (config.live === "true") return true;
  return config.allowlist
    .split(",")
    .map((n) => n.trim())
    .includes(phoneE164);
}

/**
 * Sends a free-form text message. Only valid inside the 24h session window;
 * callers outside it must use a template instead.
 */
export async function sendText(
  args: { phoneNumberId: string; to: string; body: string },
  config: WaConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (!mayMessage(args.to, config)) {
    console.warn(`[wa] blocked by allowlist: ${maskPhone(args.to)}`);
    return { status: "blocked" };
  }
  if (!config.accessToken) {
    console.info(`[wa] dry run (no WA_ACCESS_TOKEN) to ${maskPhone(args.to)}`);
    return { status: "dry_run" };
  }
  try {
    const res = await fetchImpl(
      `https://graph.facebook.com/${config.graphVersion}/${args.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: args.to.replace(/^\+/, ""),
          type: "text",
          text: { body: args.body },
        }),
      },
    );
    if (!res.ok) {
      console.error(`[wa] send failed: HTTP ${res.status} to ${maskPhone(args.to)}`);
      return { status: "failed" };
    }
    const json = (await res.json()) as { messages?: { id: string }[] };
    return { status: "sent", waMessageId: json.messages?.[0]?.id };
  } catch (err) {
    console.error(`[wa] send failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return { status: "failed" };
  }
}
