import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";

export type Table = { headers: string[]; rows: string[][] };
export type TableErrorCode = "unsupportedFormat" | "empty" | "tooLarge" | "unreadable";

export class TableError extends Error {
  constructor(public code: TableErrorCode) {
    super(code);
  }
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 5000;

/**
 * Decodes CSV bytes. Israeli banks and older Excel versions export Hebrew as
 * Windows-1255, newer tools as UTF-8 (with or without BOM) or UTF-16.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1255").decode(bytes), encoding: "windows-1255" };
  }
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", ";", "\t", "|"];
  const counts = candidates.map((d) => firstLine.split(d).length - 1);
  return candidates[counts.indexOf(Math.max(...counts))];
}

function toTable(raw: string[][]): Table {
  const rows = raw
    .map((r) => r.map((cell) => cell.trim()))
    .filter((r) => r.some((cell) => cell !== ""));
  if (rows.length < 2) throw new TableError("empty");
  if (rows.length - 1 > MAX_ROWS) throw new TableError("tooLarge");
  const [headers, ...body] = rows;
  return { headers, rows: body.map((r) => headers.map((_, i) => r[i] ?? "")) };
}

export function parseCsv(bytes: Uint8Array): Table {
  const { text } = decodeText(bytes);
  let raw: string[][];
  try {
    raw = parse(text, {
      bom: true,
      delimiter: detectDelimiter(text),
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    });
  } catch {
    throw new TableError("unreadable");
  }
  return toTable(raw);
}

/** Reads the first worksheet of an .xlsx file. */
export async function parseXlsx(bytes: Uint8Array): Promise<Table> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch {
    throw new TableError("unreadable");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new TableError("empty");
  const raw: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let col = 1; col <= sheet.columnCount; col++) cells.push(row.getCell(col).text ?? "");
    raw.push(cells);
  });
  return toTable(raw);
}

export async function parseTable(bytes: Uint8Array, filename: string): Promise<Table> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new TableError("tooLarge");
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "xlsx") return parseXlsx(bytes);
  if (ext === "csv" || ext === "txt" || ext === "tsv") return parseCsv(bytes);
  throw new TableError("unsupportedFormat"); // includes legacy .xls
}
