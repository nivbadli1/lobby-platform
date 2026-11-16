import { getTranslations } from "next-intl/server";
import { BuildingForm, emptyBuilding } from "@/components/building-form";

export default async function NewBuildingPage() {
  const t = await getTranslations("buildings");
  return (
    <>
      <h1 className="text-2xl font-semibold">{t("new")}</h1>
      <div className="card mt-6">
        <BuildingForm initial={emptyBuilding} />
      </div>
    </>
  );
}
