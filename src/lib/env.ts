import { z } from "zod";

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  WA_VERIFY_TOKEN: z.string().min(1),
  WA_APP_SECRET: z.string().min(1),
  /** Without a token, outbound messages are logged as `dry_run` instead of sent. */
  WA_ACCESS_TOKEN: z.string().min(1).optional(),
  WA_GRAPH_VERSION: z.string().default("v23.0"),
  /** Comma-separated E.164 numbers that may receive messages while WA_LIVE is not "true". */
  WA_ALLOWLIST: z.string().default(""),
  WA_LIVE: z.string().default("false"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed lazily so `next build` and unit tests do not need real secrets. */
export function env(): Env {
  if (!cached) {
    // Treat empty strings (as left in a copied .env.example) as unset.
    const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
    cached = schema.parse(raw);
  }
  return cached;
}
