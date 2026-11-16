import { createTranslator } from "next-intl";
import { resolveLocale } from "./config";
import { catalogs } from "./messages";

/**
 * Translator for text produced outside React: WhatsApp messages, cron jobs.
 * Pass the recipient's `people.lang`; unknown values fall back to the default locale.
 */
export function getTranslator(lang: string | null | undefined) {
  const locale = resolveLocale(lang);
  return createTranslator({ locale, messages: catalogs[locale], timeZone: "Asia/Jerusalem" });
}
