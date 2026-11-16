import { z } from "zod";

// Only the parts of the Cloud API webhook payload we use. Unknown fields are
// stripped, and unknown message types still parse (we answer them politely).
const message = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: z.object({ id: z.string(), mime_type: z.string().optional(), caption: z.string().optional() }).optional(),
  interactive: z
    .object({ button_reply: z.object({ id: z.string(), title: z.string() }).optional() })
    .optional(),
  button: z.object({ payload: z.string().optional(), text: z.string() }).optional(),
});

export const webhookPayload = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            messages: z.array(message).optional(),
          }),
        }),
      ),
    }),
  ),
});

export type WaMessage = z.infer<typeof message>;
export type WebhookPayload = z.infer<typeof webhookPayload>;
