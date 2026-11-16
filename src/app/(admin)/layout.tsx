import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { signOut } from "@/app/login/actions";
import { getStaff } from "@/lib/supabase/server";

export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const staff = await getStaff();
  if (!staff) redirect("/login");
  const t = await getTranslations();

  return (
    <>
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-6 px-4 py-3">
          <span className="font-semibold">{t("app.name")}</span>
          <nav className="flex flex-1 gap-4 text-sm">
            <Link href="/buildings" className="hover:underline">
              {t("nav.buildings")}
            </Link>
          </nav>
          <form action={signOut}>
            <button type="submit" className="text-sm text-neutral-600 hover:underline">
              {t("nav.signOut")}
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {staff.companyId ? (
          children
        ) : (
          <div className="card">
            <h1 className="text-xl font-semibold">{t("noAccess.title")}</h1>
            <p className="mt-2 text-neutral-700">{t("noAccess.body")}</p>
          </div>
        )}
      </main>
    </>
  );
}
