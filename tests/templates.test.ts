import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const template = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/),
  language: z.string(),
  category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]),
  components: z.tuple(
    [z.object({ type: z.literal("BODY"), text: z.string().max(1024), example: z.object({ body_text: z.array(z.array(z.string())).length(1) }) })],
    z.object({ type: z.literal("BUTTONS"), buttons: z.array(z.object({ type: z.literal("QUICK_REPLY"), text: z.string().max(25) })).min(1).max(3) }),
  ),
});

const required = [
  "welcome_resident", "ticket_received", "ticket_update", "ticket_closed_rate", "vendor_dispatch",
  "committee_approval", "payment_reminder_1", "payment_reminder_2", "payment_reminder_3",
  "payment_reminder_4", "monthly_charge_notice",
];

describe("templates/he.json", () => {
  const templates = z.array(template).parse(JSON.parse(readFileSync("templates/he.json", "utf8")));

  it("contains every required template exactly once", () => {
    expect(templates.map((t) => t.name).sort()).toEqual([...required].sort());
  });

  it.each(templates.map((t) => [t.name, t] as const))("%s: parameters are 1..n with one example each", (_n, t) => {
    const body = t.components[0];
    const used = [...body.text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    const n = body.example.body_text[0].length;
    expect([...new Set(used)].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    // Meta rejects bodies that start or end with a parameter.
    expect(body.text).not.toMatch(/^\{\{|\}\}$/);
  });

  it("vendor and committee templates carry two decision buttons", () => {
    for (const name of ["vendor_dispatch", "committee_approval"]) {
      expect(templates.find((t) => t.name === name)?.components[1]?.buttons).toHaveLength(2);
    }
  });
});
