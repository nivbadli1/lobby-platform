import { useTranslations } from "next-intl";

export default function Home() {
  const t = useTranslations();
  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <p className="text-sm text-neutral-500">{t("app.name")}</p>
      <h1 className="mt-1 text-2xl font-semibold">{t("home.title")}</h1>
      <p className="mt-4 text-neutral-700">
        {t("home.comingSoon", { webhookPath: "/api/webhooks/whatsapp" })}
      </p>
    </main>
  );
}
