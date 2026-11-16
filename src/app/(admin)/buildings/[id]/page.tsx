import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { BuildingForm } from "@/components/building-form";
import { ImportPanel } from "@/components/import-panel";
import type { ApprovalPolicy, Category, UnitRole } from "@/lib/domain";
import { agorotToShekels } from "@/lib/money";
import { supabaseServer } from "@/lib/supabase/server";

type RoleRow = {
  role: UnitRole;
  is_payer: boolean;
  units: { number: string };
  people: { full_name: string; phone_e164: string; lang: string; needs_verification: boolean };
};
type DefaultRow = { category: Category; vendor_id: string };

function byUnitNumber(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export default async function BuildingPage({ params }: PageProps<"/buildings/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const t = await getTranslations();
  const supabase = await supabaseServer();

  const [building, units, roles, vendors, defaults] = await Promise.all([
    supabase.from("buildings").select("*").eq("id", id).maybeSingle(),
    supabase.from("units").select("id, floor, number, sqm").eq("building_id", id),
    supabase
      .from("unit_roles")
      .select("role, is_payer, units!inner(number, building_id), people!inner(full_name, phone_e164, lang, needs_verification)")
      .eq("units.building_id", id),
    supabase.from("vendors").select("id, name, phone_e164, categories").order("name"),
    supabase.from("building_vendor_defaults").select("category, vendor_id").eq("building_id", id),
  ]);
  for (const result of [building, units, roles, vendors, defaults]) {
    if (result.error) throw new Error(result.error.message);
  }
  const b = building.data;
  if (!b) notFound();

  const unitRows = [...(units.data ?? [])].sort((x, y) => byUnitNumber(x.number, y.number));
  const roleRows = ((roles.data ?? []) as unknown as RoleRow[]).sort(
    (x, y) => byUnitNumber(x.units.number, y.units.number) || x.people.full_name.localeCompare(y.people.full_name),
  );
  const defaultRows = (defaults.data ?? []) as DefaultRow[];
  const fee = b.fee_per_sqm_agorot as number;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{b.name}</h1>

      <section className="card">
        <h2 className="mb-4 text-lg font-semibold">{t("buildings.details")}</h2>
        <BuildingForm
          initial={{
            id: b.id,
            name: b.name,
            slug: b.slug,
            address: b.address ?? "",
            fee_per_sqm: agorotToShekels(fee),
            approval_threshold: agorotToShekels(b.approval_threshold_agorot),
            bank_account_ref: b.bank_account_ref ?? "",
            approval_policy: b.approval_policy as ApprovalPolicy,
          }}
        />
      </section>

      <ImportPanel buildingId={b.id} />

      <section className="card">
        <h2 className="text-lg font-semibold">{t("building.units", { count: unitRows.length })}</h2>
        {unitRows.length === 0 ? (
          <p className="mt-2 text-neutral-600">{t("building.noUnits")}</p>
        ) : (
          <table className="table mt-3">
            <thead>
              <tr>
                <th>{t("building.unit")}</th>
                <th>{t("building.floor")}</th>
                <th>{t("building.sqm")}</th>
                <th>{t("building.monthlyFee")}</th>
              </tr>
            </thead>
            <tbody>
              {unitRows.map((u) => (
                <tr key={u.id}>
                  <td>{u.number}</td>
                  <td>{u.floor}</td>
                  <td>{Number(u.sqm)}</td>
                  <td>{agorotToShekels(Math.round(Number(u.sqm) * fee))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">{t("building.people", { count: roleRows.length })}</h2>
        {roleRows.length === 0 ? (
          <p className="mt-2 text-neutral-600">{t("building.noPeople")}</p>
        ) : (
          <table className="table mt-3">
            <thead>
              <tr>
                <th>{t("building.unit")}</th>
                <th>{t("building.fullName")}</th>
                <th>{t("building.phone")}</th>
                <th>{t("building.role")}</th>
                <th>{t("building.payer")}</th>
                <th>{t("building.lang")}</th>
              </tr>
            </thead>
            <tbody>
              {roleRows.map((r, i) => (
                <tr key={i}>
                  <td>{r.units.number}</td>
                  <td>
                    {r.people.full_name}
                    {r.people.needs_verification && (
                      <span className="ms-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                        {t("building.needsVerification")}
                      </span>
                    )}
                  </td>
                  <td dir="ltr" className="text-end">{r.people.phone_e164}</td>
                  <td>{t(`roles.${r.role}`)}</td>
                  <td>{r.is_payer ? t("common.yes") : ""}</td>
                  <td>{r.people.lang}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">{t("building.vendors", { count: vendors.data?.length ?? 0 })}</h2>
        {(vendors.data ?? []).length === 0 ? (
          <p className="mt-2 text-neutral-600">{t("building.noVendors")}</p>
        ) : (
          <table className="table mt-3">
            <thead>
              <tr>
                <th>{t("building.vendorName")}</th>
                <th>{t("building.phone")}</th>
                <th>{t("building.vendorCategories")}</th>
                <th>{t("building.defaultFor")}</th>
              </tr>
            </thead>
            <tbody>
              {(vendors.data ?? []).map((v) => (
                <tr key={v.id}>
                  <td>{v.name}</td>
                  <td dir="ltr" className="text-end">{v.phone_e164}</td>
                  <td>{(v.categories as Category[]).map((c) => t(`categories.${c}`)).join(", ")}</td>
                  <td>
                    {defaultRows
                      .filter((d) => d.vendor_id === v.id)
                      .map((d) => t(`categories.${d.category}`))
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
