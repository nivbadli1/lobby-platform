"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { APPROVAL_POLICIES, CATEGORIES, UNIT_ROLES } from "@/lib/domain";
import {
  IMPORT_KINDS,
  validatePeople,
  validateUnits,
  validateVendors,
  type ImportError,
  type ImportKind,
  type RowsByKind,
} from "@/lib/import/validate";
import { shekelsToAgorot } from "@/lib/money";
import { getStaff, supabaseServer } from "@/lib/supabase/server";
import { parseTable, TableError, type TableErrorCode } from "@/lib/tabular";

// ---------------------------------------------------------------- building form

export type BuildingField = "name" | "slug" | "fee_per_sqm" | "approval_threshold";
export type BuildingFormError = "required" | "invalidSlug" | "slugTaken" | "invalidAmount" | "generic";
export type BuildingFormState = {
  saved?: boolean;
  formError?: BuildingFormError;
  fieldErrors?: Partial<Record<BuildingField, BuildingFormError>>;
  /** Submitted values, echoed back on failure so the form keeps what was typed. */
  values?: Record<string, string>;
};

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function saveBuilding(_prev: BuildingFormState, formData: FormData): Promise<BuildingFormState> {
  const staff = await getStaff();
  if (!staff?.companyId) return { formError: "generic" };

  const text = (key: string) => String(formData.get(key) ?? "").trim();
  const id = text("id") || null;
  const fieldErrors: BuildingFormState["fieldErrors"] = {};
  const submitted = Object.fromEntries(
    ["name", "slug", "address", "fee_per_sqm", "approval_threshold", "bank_account_ref", "approval_policy"].map(
      (key) => [key, text(key)],
    ),
  );

  const name = text("name");
  if (!name) fieldErrors.name = "required";
  const slug = text("slug").toLowerCase();
  if (!slug) fieldErrors.slug = "required";
  else if (!SLUG.test(slug)) fieldErrors.slug = "invalidSlug";
  const fee = shekelsToAgorot(text("fee_per_sqm"));
  if (fee === null) fieldErrors.fee_per_sqm = "invalidAmount";
  const threshold = shekelsToAgorot(text("approval_threshold"));
  if (threshold === null) fieldErrors.approval_threshold = "invalidAmount";
  const policy = z.enum(APPROVAL_POLICIES).safeParse(text("approval_policy"));
  if (Object.keys(fieldErrors).length > 0 || !policy.success) return { fieldErrors, values: submitted };

  const values = {
    name,
    slug,
    address: text("address") || null,
    fee_per_sqm_agorot: fee,
    approval_threshold_agorot: threshold,
    bank_account_ref: text("bank_account_ref") || null,
    approval_policy: policy.data,
  };

  const supabase = await supabaseServer();
  const query = id
    ? supabase.from("buildings").update(values).eq("id", id).select("id")
    : supabase.from("buildings").insert({ ...values, company_id: staff.companyId }).select("id");
  const { data, error } = await query;
  if (error?.code === "23505") return { fieldErrors: { slug: "slugTaken" }, values: submitted };
  if (error || !data?.[0]) return { formError: "generic", values: submitted };

  revalidatePath("/buildings");
  if (!id) redirect(`/buildings/${data[0].id}`);
  revalidatePath(`/buildings/${id}`);
  return { saved: true };
}

// ---------------------------------------------------------------- imports

export type ImportPreview = {
  [K in ImportKind]: { kind: K; rows: RowsByKind[K]; errors: ImportError[] };
}[ImportKind];

export type PreviewState = { fileError?: TableErrorCode | "noFile"; preview?: ImportPreview };

/** Step 1: parse and validate the uploaded file. Nothing is written. */
export async function previewImport(formData: FormData): Promise<PreviewState> {
  const staff = await getStaff();
  if (!staff?.companyId) return { fileError: "unreadable" };

  const kind = z.enum(IMPORT_KINDS).safeParse(formData.get("kind"));
  const buildingId = z.uuid().safeParse(formData.get("buildingId"));
  const file = formData.get("file");
  if (!kind.success || !buildingId.success) return { fileError: "unreadable" };
  if (!(file instanceof File) || file.size === 0) return { fileError: "noFile" };

  let table;
  try {
    table = await parseTable(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (err) {
    return { fileError: err instanceof TableError ? err.code : "unreadable" };
  }

  if (kind.data === "units") return { preview: { kind: "units", ...validateUnits(table) } };
  if (kind.data === "vendors") return { preview: { kind: "vendors", ...validateVendors(table) } };

  const supabase = await supabaseServer();
  const { data: units, error } = await supabase.from("units").select("number").eq("building_id", buildingId.data);
  if (error) return { fileError: "unreadable" };
  const unitNumbers = new Set((units ?? []).map((u) => u.number as string));
  return { preview: { kind: "people", ...validatePeople(table, unitNumbers) } };
}

const phone = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const rowSchemas = {
  units: z.object({ floor: z.int(), number: z.string().min(1), sqm: z.number().positive() }),
  people: z.object({
    full_name: z.string().min(1),
    phone_e164: phone,
    lang: z.string().regex(/^[a-z]{2}$/),
    unit_number: z.string().min(1),
    role: z.enum(UNIT_ROLES),
    is_payer: z.boolean(),
    receives_updates: z.boolean(),
  }),
  vendors: z.object({
    name: z.string().min(1),
    phone_e164: phone,
    categories: z.array(z.enum(CATEGORIES)).min(1),
    is_default: z.boolean(),
  }),
} as const;

export type CommitState = { ok: true; count: number } | { ok: false };

/**
 * Step 2: write the previewed rows. The rows come back from the browser, so
 * they are re-checked here; the SQL function then imports all of them or none.
 */
export async function commitImport(buildingId: string, kind: ImportKind, rows: unknown): Promise<CommitState> {
  const staff = await getStaff();
  if (!staff?.companyId) return { ok: false };
  if (!z.uuid().safeParse(buildingId).success || !IMPORT_KINDS.includes(kind)) return { ok: false };
  const parsed = z.array(rowSchemas[kind]).min(1).max(5000).safeParse(rows);
  if (!parsed.success) return { ok: false };

  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc(`import_${kind}`, { p_building_id: buildingId, p_rows: parsed.data });
  if (error) {
    console.error(`[import] ${kind} failed: ${error.message}`);
    return { ok: false };
  }
  revalidatePath(`/buildings/${buildingId}`);
  return { ok: true, count: Number(data) };
}
