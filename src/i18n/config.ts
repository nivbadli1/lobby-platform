export const locales = ["he", "en"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "he";

const rtlLocales: ReadonlySet<Locale> = new Set(["he"]);

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/** Maps a stored `people.lang` (or anything else) to a supported locale. */
export function resolveLocale(lang: string | null | undefined): Locale {
  return isLocale(lang) ? lang : defaultLocale;
}

export function direction(locale: Locale): "rtl" | "ltr" {
  return rtlLocales.has(locale) ? "rtl" : "ltr";
}
