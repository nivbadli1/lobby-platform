/** Parses a shekel amount typed by a person ("6.5", "1,500", "₪ 12.30") into integer agorot. */
export function shekelsToAgorot(input: string): number | null {
  const cleaned = input.replace(/[\s,₪]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function agorotToShekels(agorot: number): string {
  return (agorot / 100).toFixed(2);
}
