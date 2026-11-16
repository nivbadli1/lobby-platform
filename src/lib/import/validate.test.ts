import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { shekelsToAgorot } from "@/lib/money";
import { decodeText, parseCsv, parseTable, TableError } from "@/lib/tabular";
import { validatePeople, validateUnits, validateVendors } from "./validate";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Minimal Windows-1255 encoder: ASCII plus the Hebrew alphabet (U+05D0..U+05EA -> 0xE0..0xFA). */
function win1255(s: string): Uint8Array {
  return Uint8Array.from([...s].map((ch) => {
    const code = ch.charCodeAt(0);
    if (code < 0x80) return code;
    if (code >= 0x05d0 && code <= 0x05ea) return code - 0x05d0 + 0xe0;
    throw new Error(`unmapped char ${ch}`);
  }));
}

describe("tabular parsing", () => {
  it("decodes Windows-1255 Hebrew and semicolon-delimited CSV", () => {
    const bytes = win1255("קומה;דירה;שטח\r\n1;1;85\r\n2;5;102,5\r\n");
    expect(decodeText(bytes).encoding).toBe("windows-1255");
    expect(parseCsv(bytes)).toEqual({ headers: ["קומה", "דירה", "שטח"], rows: [["1", "1", "85"], ["2", "5", "102,5"]] });
  });

  it("handles a UTF-8 BOM, quoted fields, blank lines and short rows", () => {
    const table = parseCsv(utf8('﻿name,phone,categories\n"Lift, Ltd",050-1234567,"elevator, door"\n\nSolo\n'));
    expect(table.headers).toEqual(["name", "phone", "categories"]);
    expect(table.rows).toEqual([["Lift, Ltd", "050-1234567", "elevator, door"], ["Solo", "", ""]]);
  });

  it("reads the first sheet of an xlsx file, including numeric cells", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("units");
    ws.addRow(["קומה", "מספר דירה", 'שטח במ"ר']);
    ws.addRow([1, 1, 85.5]);
    ws.addRow([-1, "מחסן", 12]);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const table = await parseTable(bytes, "building.XLSX");
    expect(table.rows).toEqual([["1", "1", "85.5"], ["-1", "מחסן", "12"]]);
    expect(validateUnits(table)).toEqual({
      rows: [{ floor: 1, number: "1", sqm: 85.5 }, { floor: -1, number: "מחסן", sqm: 12 }],
      errors: [],
    });
  });

  it("rejects unsupported and empty files", async () => {
    await expect(parseTable(utf8("x"), "old.xls")).rejects.toMatchObject({ code: "unsupportedFormat" });
    expect(() => parseCsv(utf8("floor,number,sqm\n"))).toThrow(TableError);
  });
});

describe("validateUnits", () => {
  it("accepts Hebrew headers and decimal commas", () => {
    const { rows, errors } = validateUnits(parseCsv(utf8("קומה;דירה;מ״ר\n3;12;102,5\n")));
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ floor: 3, number: "12", sqm: 102.5 }]);
  });

  it("reports bad numbers, duplicates and missing values with line numbers", () => {
    const { rows, errors } = validateUnits(parseCsv(utf8("floor,number,sqm\n1,1,80\nx,2,80\n1,1,90\n2,3,0\n2,,70\n")));
    expect(rows).toEqual([{ floor: 1, number: "1", sqm: 80 }]);
    expect(errors).toEqual([
      { line: 3, field: "floor", code: "invalidNumber", value: "x" },
      { line: 4, field: "number", code: "duplicate", value: "1" },
      { line: 5, field: "sqm", code: "invalidNumber", value: "0" },
      { line: 6, field: "number", code: "required", value: undefined },
    ]);
  });

  it("reports missing columns once, for the whole file", () => {
    expect(validateUnits(parseCsv(utf8("floor,apartment\n1,1\n"))).errors).toEqual([
      { line: 0, field: "sqm", code: "missingColumn" },
    ]);
  });
});

describe("validatePeople", () => {
  const units = new Set(["1", "2"]);
  const csv = (body: string) => parseCsv(utf8(`שם מלא,טלפון,דירה,תפקיד,משלם,שפה\n${body}`));

  it("normalises phones, roles, booleans and language", () => {
    const { rows, errors } = validatePeople(
      csv("דנה לוי,050-1234567,1,בעלים,כן,\nJohn Smith,521234567,2,tenant,yes,EN\nדנה לוי,0501234567,1,ועד בית,,\n"),
      units,
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { full_name: "דנה לוי", phone_e164: "+972501234567", lang: "he", unit_number: "1", role: "owner", is_payer: true, receives_updates: true },
      { full_name: "John Smith", phone_e164: "+972521234567", lang: "en", unit_number: "2", role: "tenant", is_payer: true, receives_updates: true },
      { full_name: "דנה לוי", phone_e164: "+972501234567", lang: "he", unit_number: "1", role: "committee", is_payer: false, receives_updates: true },
    ]);
  });

  it("rejects unknown units, bad phones and roles, duplicates and two payers for one unit", () => {
    const { rows, errors } = validatePeople(
      csv("A,0501111111,9,owner,,\nB,123,1,owner,,\nC,0502222222,1,boss,,\nD,0503333333,1,owner,כן,\nD,0503333333,1,owner,,\nE,0504444444,1,tenant,כן,\nF,0505555555,2,tenant,maybe,\n"),
      units,
    );
    expect(rows.map((r) => r.full_name)).toEqual(["D"]);
    expect(errors.map((e) => [e.line, e.field, e.code])).toEqual([
      [2, "unit_number", "unknownUnit"],
      [3, "phone", "invalidPhone"],
      [4, "role", "invalidRole"],
      [6, "phone", "duplicate"],
      [7, "is_payer", "multiplePayers"],
      [8, "is_payer", "invalidBoolean"],
    ]);
  });

  it("keeps one payer flag when the payer appears twice for the same unit", () => {
    const { rows, errors } = validatePeople(csv("D,0503333333,1,owner,כן,\nD,0503333333,1,committee,כן,\n"), units);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.is_payer)).toEqual([true, false]);
  });
});

describe("validateVendors", () => {
  const csv = (body: string) => parseCsv(utf8(`שם ספק,טלפון,קטגוריות,ברירת מחדל\n${body}`));

  it("maps Hebrew categories and defaults", () => {
    const { rows, errors } = validateVendors(csv('מעליות בע"מ,03-5551234,מעלית,כן\nאבי,0501234567,"חשמל, נזילות; ניקיון",\n'));
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { name: 'מעליות בע"מ', phone_e164: "+97235551234", categories: ["elevator"], is_default: true },
      { name: "אבי", phone_e164: "+972501234567", categories: ["common_electricity", "leak", "cleaning"], is_default: false },
    ]);
  });

  it("rejects unknown categories, duplicate phones and two defaults for one category", () => {
    const { errors } = validateVendors(
      csv("A,0501111111,גינון,\nB,0502222222,מעלית,כן\nB2,0502222222,ניקיון,\nC,0503333333,מעלית,כן\nD,0504444444,,\n"),
    );
    expect(errors.map((e) => [e.line, e.field, e.code])).toEqual([
      [2, "categories", "invalidCategory"],
      [4, "phone", "duplicate"],
      [5, "is_default", "multipleDefaults"],
      [6, "categories", "required"],
    ]);
  });
});

describe("shekelsToAgorot", () => {
  it.each([["6.5", 650], ["6.50", 650], ["1,500", 150000], ["₪ 12.30", 1230], ["0", 0], ["19.99", 1999]])(
    "%s -> %i",
    (input, expected) => expect(shekelsToAgorot(input)).toBe(expected),
  );
  it.each(["", "abc", "-5", "1.234", "1.2.3"])("rejects %j", (input) => expect(shekelsToAgorot(input)).toBeNull());
});
