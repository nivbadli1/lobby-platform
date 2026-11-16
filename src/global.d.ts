import type { Locale } from "@/i18n/config";
import type { Messages } from "@/i18n/messages";

// Type-checks translation keys in `useTranslations` / `getTranslator`.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
