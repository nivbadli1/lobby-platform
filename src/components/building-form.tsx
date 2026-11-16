"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { saveBuilding, type BuildingField, type BuildingFormState } from "@/app/(admin)/buildings/actions";
import { APPROVAL_POLICIES, type ApprovalPolicy } from "@/lib/domain";

export type BuildingFormValues = {
  id?: string;
  name: string;
  slug: string;
  address: string;
  fee_per_sqm: string;
  approval_threshold: string;
  bank_account_ref: string;
  approval_policy: ApprovalPolicy;
};

export const emptyBuilding: BuildingFormValues = {
  name: "",
  slug: "",
  address: "",
  fee_per_sqm: "",
  approval_threshold: "",
  bank_account_ref: "",
  approval_policy: "first",
};

export function BuildingForm({ initial: saved }: { initial: BuildingFormValues }) {
  const t = useTranslations("buildings");
  const [state, action, pending] = useActionState<BuildingFormState, FormData>(saveBuilding, {});
  // React resets a form after its action runs; after a failed save, show what was typed.
  const initial = { ...saved, ...state.values } as BuildingFormValues;
  const error = (field: BuildingField) => {
    const code = state.fieldErrors?.[field];
    return code ? <small role="alert" className="!text-red-700">{t(`errors.${code}`)}</small> : null;
  };

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <label className="field">
        <span>{t("name")}</span>
        <input name="name" defaultValue={initial.name} required />
        {error("name")}
      </label>
      <label className="field">
        <span>{t("slug")}</span>
        <input name="slug" defaultValue={initial.slug} required dir="ltr" pattern="[a-z0-9]+(-[a-z0-9]+)*" />
        <small>{t("slugHint", { slug: initial.slug || "my-building" })}</small>
        {error("slug")}
      </label>
      <label className="field sm:col-span-2">
        <span>{t("address")}</span>
        <input name="address" defaultValue={initial.address} />
      </label>
      <label className="field">
        <span>{t("feePerSqm")}</span>
        <input name="fee_per_sqm" defaultValue={initial.fee_per_sqm} required inputMode="decimal" dir="ltr" />
        {error("fee_per_sqm")}
      </label>
      <label className="field">
        <span>{t("approvalThreshold")}</span>
        <input name="approval_threshold" defaultValue={initial.approval_threshold} required inputMode="decimal" dir="ltr" />
        {error("approval_threshold")}
      </label>
      <label className="field">
        <span>{t("approvalPolicy")}</span>
        <select name="approval_policy" defaultValue={initial.approval_policy}>
          {APPROVAL_POLICIES.map((p) => (
            <option key={p} value={p}>
              {t(`policy.${p}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t("bankAccountRef")}</span>
        <input name="bank_account_ref" defaultValue={initial.bank_account_ref} />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className="btn-primary">
          {initial.id ? t("save") : t("create")}
        </button>
        {state.saved && <span role="status" className="text-sm text-green-700">{t("saved")}</span>}
        {state.formError && <span role="alert" className="text-sm text-red-700">{t(`errors.${state.formError}`)}</span>}
      </div>
    </form>
  );
}
