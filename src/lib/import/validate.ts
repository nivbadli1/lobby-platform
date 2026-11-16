import aliases from "../../../config/import-aliases.json";
import { CATEGORIES, UNIT_ROLES, type Category, type UnitRole } from "@/lib/domain";
import { toE164 } from "@/lib/phone";
import type { Table } from "@/lib/tabular";

export const IMPORT_KINDS = ["units", "people", "vendors"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export type UnitRow = { floor: number; number: string; sqm: number };
export type PersonRow = {
  full_name: string;
  phone_e164: string;
  lang: string;
  unit_number: string;
  role: UnitRole;
  is_payer: boolean;
  receives_updates: boolean;
};
export type VendorRow = { name: string; phone_e164: string; categories: Category[]; is_default: boolean };
export type RowsByKind = { units: UnitRow[]; people: PersonRow[]; vendors: VendorRow[] };

export type ImportErrorCode =
  | "missingColumn"
  | "required"
  | "invalidNumber"
  | "invalidPhone"
  | "invalidRole"
  | "invalidCategory"
  | "invalidBoolean"
  | "duplicate"
  | "multiplePayers"
  | "multipleDefaults"
  | "unknownUnit";

/** `line` is the spreadsheet line (header = 1); 0 means the file as a whole. */
export type ImportError = { line: number; field: string; code: ImportErrorCode; value?: string };
export type ImportResult<T> = { rows: T[]; errors: ImportError[] };

const REQUIRED: Record<ImportKind, string[]> = {
  units: ["floor", "number", "sqm"],
  people: ["full_name", "phone", "unit_number", "role"],
  vendors: ["name", "phone", "categories"],
};

/** Case, spacing and Hebrew punctuation (gershayim, geresh) vary between exports. */
function norm(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[\u05F4\u201C\u201D]/g, '"')
    .replace(/[\u05F3\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function lookup<T extends string>(map: Record<T, string[]>, value: string): T | null {
  const v = norm(value);
  for (const key of Object.keys(map) as T[]) if (map[key].some((a) => norm(a) === v)) return key;
  return null;
}

function parseBool(value: string, fallback: boolean): boolean | null {
  const v = norm(value);
  if (v === "") return fallback;
  if (aliases.values.yes.includes(v)) return true;
  if (aliases.values.no.includes(v)) return false;
  return null;
}

/** Maps canonical field -> column index using the header aliases. */
function mapColumns(kind: ImportKind, table: Table, errors: ImportError[]): Record<string, number> {
  const fields = aliases.headers[kind] as Record<string, string[]>;
  const columns: Record<string, number> = {};
  table.headers.forEach((header, index) => {
    const field = lookup(fields, header);
    if (field && !(field in columns)) columns[field] = index;
  });
  for (const field of REQUIRED[kind]) {
    if (!(field in columns)) errors.push({ line: 0, field, code: "missingColumn" });
  }
  return columns;
}

type Reader = { line: number; get(field: string): string; fail(field: string, code: ImportErrorCode): null };

function eachRow(
  kind: ImportKind,
  table: Table,
  errors: ImportError[],
  visit: (row: Reader) => void,
): void {
  const columns = mapColumns(kind, table, errors);
  if (errors.length > 0) return;
  table.rows.forEach((cells, i) => {
    const line = i + 2;
    const get = (field: string) => (field in columns ? cells[columns[field]] : "");
    visit({
      line,
      get,
      fail(field, code) {
        errors.push({ line, field, code, value: get(field) || undefined });
        return null;
      },
    });
  });
}

function requiredText(row: Reader, field: string): string | null {
  const value = row.get(field);
  return value === "" ? row.fail(field, "required") : value;
}

function phone(row: Reader): string | null {
  const raw = row.get("phone");
  if (raw === "") return row.fail("phone", "required");
  return toE164(raw, { assumeLocal: true }) ?? row.fail("phone", "invalidPhone");
}

export function validateUnits(table: Table): ImportResult<UnitRow> {
  const errors: ImportError[] = [];
  const rows: UnitRow[] = [];
  const seen = new Set<string>();
  eachRow("units", table, errors, (row) => {
    const number = requiredText(row, "number");
    const floorText = row.get("floor");
    const floor = /^-?\d+$/.test(floorText) ? Number(floorText) : row.fail("floor", floorText ? "invalidNumber" : "required");
    const sqmText = row.get("sqm").replace(",", ".");
    const sqm =
      /^\d+(\.\d+)?$/.test(sqmText) && Number(sqmText) > 0 && Number(sqmText) < 100000
        ? Math.round(Number(sqmText) * 100) / 100
        : row.fail("sqm", sqmText ? "invalidNumber" : "required");
    if (number !== null && seen.has(number)) return void row.fail("number", "duplicate");
    if (number === null || floor === null || sqm === null) return;
    seen.add(number);
    rows.push({ floor, number, sqm });
  });
  return { rows, errors };
}

/** `unitNumbers`: units that already exist in the building. */
export function validatePeople(table: Table, unitNumbers: ReadonlySet<string>): ImportResult<PersonRow> {
  const errors: ImportError[] = [];
  const rows: PersonRow[] = [];
  const seen = new Set<string>();
  const payerByUnit = new Map<string, string>();
  eachRow("people", table, errors, (row) => {
    const full_name = requiredText(row, "full_name");
    const phone_e164 = phone(row);
    let unit_number = requiredText(row, "unit_number");
    if (unit_number !== null && !unitNumbers.has(unit_number)) unit_number = row.fail("unit_number", "unknownUnit");
    const roleText = row.get("role");
    const role = roleText === "" ? row.fail("role", "required") : (lookup(aliases.values.role, roleText) ?? row.fail("role", "invalidRole"));
    const is_payer = parseBool(row.get("is_payer"), false) ?? row.fail("is_payer", "invalidBoolean");
    const receives_updates = parseBool(row.get("receives_updates"), true) ?? row.fail("receives_updates", "invalidBoolean");
    const langText = norm(row.get("lang"));
    const lang = /^[a-z]{2}$/.test(langText) ? langText : "he";
    if (full_name === null || phone_e164 === null || unit_number === null || role === null) return;
    if (is_payer === null || receives_updates === null) return;

    const key = `${unit_number}|${phone_e164}|${role}`;
    if (seen.has(key)) return void row.fail("phone", "duplicate");
    seen.add(key);
    if (is_payer) {
      const existing = payerByUnit.get(unit_number);
      if (existing && existing !== phone_e164) return void row.fail("is_payer", "multiplePayers");
      // The same person listed twice for a unit (e.g. owner + committee) pays once.
      if (existing === phone_e164) {
        rows.push({ full_name, phone_e164, lang, unit_number, role: role as UnitRole, is_payer: false, receives_updates });
        return;
      }
      payerByUnit.set(unit_number, phone_e164);
    }
    rows.push({ full_name, phone_e164, lang, unit_number, role: role as UnitRole, is_payer, receives_updates });
  });
  return { rows, errors };
}

export function validateVendors(table: Table): ImportResult<VendorRow> {
  const errors: ImportError[] = [];
  const rows: VendorRow[] = [];
  const seen = new Set<string>();
  const defaultByCategory = new Map<Category, string>();
  eachRow("vendors", table, errors, (row) => {
    const name = requiredText(row, "name");
    const phone_e164 = phone(row);
    const parts = row.get("categories").split(/[,;/|\n]/).map((p) => p.trim()).filter(Boolean);
    let categories: Category[] | null = null;
    if (parts.length === 0) row.fail("categories", "required");
    else {
      const mapped = parts.map((p) => lookup(aliases.values.category, p));
      categories = mapped.includes(null) ? row.fail("categories", "invalidCategory") : [...new Set(mapped as Category[])];
    }
    const is_default = parseBool(row.get("is_default"), false) ?? row.fail("is_default", "invalidBoolean");
    if (name === null || phone_e164 === null || categories === null || is_default === null) return;
    if (seen.has(phone_e164)) return void row.fail("phone", "duplicate");
    if (is_default && categories.some((c) => defaultByCategory.has(c))) return void row.fail("is_default", "multipleDefaults");
    seen.add(phone_e164);
    if (is_default) categories.forEach((c) => defaultByCategory.set(c, phone_e164));
    rows.push({ name, phone_e164, categories, is_default });
  });
  return { rows, errors };
}

// Sanity check that the alias file covers exactly the domain enums.
const covers = <T extends string>(map: Record<string, unknown>, values: readonly T[]) =>
  values.every((v) => v in map) && Object.keys(map).length === values.length;
if (!covers(aliases.values.role, UNIT_ROLES) || !covers(aliases.values.category, CATEGORIES)) {
  throw new Error("config/import-aliases.json is out of sync with src/lib/domain.ts");
}
