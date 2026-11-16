import en from "../../messages/en.json";
import he from "../../messages/he.json";
import type { Locale } from "./config";

/** The default-locale catalog defines the message shape; other locales must match it. */
export type Messages = typeof he;

export const catalogs: Record<Locale, Messages> = { he, en };
