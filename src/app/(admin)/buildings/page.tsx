import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase/server";

export default async function BuildingsPage() {
  const t = await getTranslations("buildings");
  const supabase = await supabaseServer();
  const { data: buildings, error } = await supabase
    .from("buildings")
    .select("id, name, slug, address")
    .order("name");
  if (error) throw new Error(error.message);

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Link href="/buildings/new" className="btn-primary">
          {t("new")}
        </Link>
      </div>
      {buildings.length === 0 ? (
        <p className="card mt-6 text-neutral-700">{t("empty")}</p>
      ) : (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {buildings.map((b) => (
            <li key={b.id}>
              <Link href={`/buildings/${b.id}`} className="card block hover:border-blue-600">
                <span className="text-lg font-medium">{b.name}</span>
                <span className="mt-1 block text-sm text-neutral-600">{b.address}</span>
                <span className="mt-1 block text-xs text-neutral-500" dir="ltr">
                  /report/{b.slug}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
