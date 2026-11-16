const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Normalises a phone number to E.164. Accepts WhatsApp's `wa_id` format
 * (digits without "+"), E.164, and local Israeli numbers (05X-XXXXXXX).
 * With `assumeLocal` (spreadsheet imports), 8-9 digit numbers are treated as
 * Israeli numbers that lost their leading zero.
 * Returns null if the result is not a plausible E.164 number.
 */
export function toE164(input: string, options: { assumeLocal?: boolean } = {}): string | null {
  const digits = input.replace(/[^\d+]/g, "");
  let candidate: string;
  if (digits.startsWith("+")) candidate = digits;
  // Spreadsheets drop the leading zero of numeric cells: 501234567 means 050-1234567.
  else if (options.assumeLocal && /^[2-9]\d{7,8}$/.test(digits)) candidate = `+972${digits}`;
  else if (digits.startsWith("00")) candidate = `+${digits.slice(2)}`;
  else if (digits.startsWith("0")) candidate = `+972${digits.slice(1)}`;
  else candidate = `+${digits}`;
  return E164.test(candidate) ? candidate : null;
}

/** For logs: phone numbers are personal data, so keep only the last 3 digits. */
export function maskPhone(phone: string): string {
  return `***${phone.slice(-3)}`;
}
