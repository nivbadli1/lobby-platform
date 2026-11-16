import { getRequestConfig } from "next-intl/server";
import { defaultLocale } from "./config";
import { catalogs } from "./messages";

// The admin UI ships in the default locale only for the pilot. To let staff
// switch language later, resolve the locale here (cookie or user profile).
export default getRequestConfig(async () => {
  const locale = defaultLocale;
  return { locale, messages: catalogs[locale], timeZone: "Asia/Jerusalem" };
});
