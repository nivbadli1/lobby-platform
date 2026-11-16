import { describe, expect, it } from "vitest";
import { maskPhone, toE164 } from "./phone";

describe("toE164", () => {
  it.each([
    ["972501234567", "+972501234567"], // WhatsApp wa_id
    ["+972501234567", "+972501234567"],
    ["050-123-4567", "+972501234567"],
    ["00972 50 123 4567", "+972501234567"],
    ["(03) 555-1234", "+97235551234"],
  ])("%s -> %s", (input, expected) => expect(toE164(input)).toBe(expected));

  it("rejects junk", () => {
    expect(toE164("")).toBeNull();
    expect(toE164("123")).toBeNull();
    expect(toE164("not a phone")).toBeNull();
  });
});

it("maskPhone keeps only the last 3 digits", () => {
  expect(maskPhone("+972501234567")).toBe("***567");
});
