import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultLocale, direction, locales, resolveLocale } from "@/i18n/config";
import { catalogs } from "@/i18n/messages";
import { getTranslator } from "@/i18n/translator";

function keys(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [prefix];
  return Object.entries(node).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("i18n", () => {
  it("every locale has exactly the keys of the default locale", () => {
    const expected = keys(catalogs[defaultLocale]).sort();
    for (const locale of locales) expect(keys(catalogs[locale]).sort(), locale).toEqual(expected);
  });

  it("has no hardcoded Hebrew in src/ (strings belong in messages/*.json)", () => {
    const offenders = sourceFiles("src").filter((f) => /[֐-׿]/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("falls back to the default locale for unknown languages", () => {
    expect(resolveLocale("ru")).toBe("he");
    expect(resolveLocale(null)).toBe("he");
    expect(resolveLocale("en")).toBe("en");
    expect(getTranslator("xx")("app.name")).toBe(catalogs.he.app.name);
  });

  it("Hebrew is RTL", () => {
    expect(direction("he")).toBe("rtl");
    expect(direction("en")).toBe("ltr");
  });
});
