"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { signIn } from "./actions";

export default function LoginPage() {
  const t = useTranslations();
  const [state, action, pending] = useActionState(signIn, { error: false });
  return (
    <main className="mx-auto mt-24 w-full max-w-sm p-6">
      <p className="text-sm text-neutral-500">{t("app.name")}</p>
      <h1 className="mt-1 text-2xl font-semibold">{t("login.title")}</h1>
      <form action={action} className="mt-6 flex flex-col gap-4">
        <label className="field">
          <span>{t("login.email")}</span>
          <input name="email" type="email" autoComplete="email" required dir="ltr" />
        </label>
        <label className="field">
          <span>{t("login.password")}</span>
          <input name="password" type="password" autoComplete="current-password" required dir="ltr" />
        </label>
        {state.error && <p role="alert" className="text-sm text-red-700">{t("login.invalid")}</p>}
        <button type="submit" disabled={pending} className="btn-primary">
          {t("login.submit")}
        </button>
      </form>
    </main>
  );
}
