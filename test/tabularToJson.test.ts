import { describe, it, expect } from "vitest";
import {
  tabularToJson,
  detectFormat,
  parseMarkdownTable,
  inferCell,
  columnType,
  normalizeHeaders,
  looksLikeHeader,
} from "../src/tools/tabularToJson.js";

describe("detectFormat", () => {
  it("detects a Markdown table by its separator row", () => {
    expect(detectFormat("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("markdown");
  });
  it("detects TSV by tabs", () => {
    expect(detectFormat("a\tb\n1\t2")).toBe("tsv");
  });
  it("falls back to CSV", () => {
    expect(detectFormat("a,b\n1,2")).toBe("csv");
  });
});

describe("tabularToJson — CSV", () => {
  it("parses a simple CSV with a header and infers types", () => {
    const r = tabularToJson("name,age\nAda,36\nGrace,45");
    expect(r.ok).toBe(true);
    expect(r.format).toBe("csv");
    expect(r.columns).toEqual([
      { name: "name", type: "string" },
      { name: "age", type: "integer" },
    ]);
    expect(r.rows).toEqual([
      { name: "Ada", age: 36 },
      { name: "Grace", age: 45 },
    ]);
    expect(r.rowCount).toBe(2);
  });

  it("handles quoted fields with embedded commas and newlines", () => {
    const r = tabularToJson('name,note\n"Ada","a, b\nc"');
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toEqual({ name: "Ada", note: "a, b\nc" });
  });

  it("sniffs a semicolon delimiter", () => {
    const r = tabularToJson("name;age\nAda;36");
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toEqual({ name: "Ada", age: 36 });
  });

  it("strips a leading BOM and reports it", () => {
    const r = tabularToJson("﻿name,age\nAda,36");
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toEqual({ name: "Ada", age: 36 });
    expect(r.repairs.join(" ")).toMatch(/BOM|byte-order/i);
  });

  it("pads ragged short rows with null and reports it", () => {
    const r = tabularToJson("a,b,c\n1,2,3\n4,5");
    expect(r.ok).toBe(true);
    expect(r.rows[1]).toEqual({ a: 4, b: 5, c: null });
    expect(r.repairs.join(" ")).toMatch(/Padded/i);
  });

  it("truncates rows wider than the header and reports it", () => {
    const r = tabularToJson("a,b\n1,2,3\n4,5", { hasHeader: "true" });
    expect(r.ok).toBe(true);
    expect(r.columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(r.rows).toEqual([
      { a: 1, b: 2 },
      { a: 4, b: 5 },
    ]);
    expect(r.repairs.join(" ")).toMatch(/Truncated/i);
  });
});

describe("tabularToJson — TSV", () => {
  it("parses tab-delimited input", () => {
    const r = tabularToJson("name\tage\nAda\t36", { format: "tsv" });
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toEqual({ name: "Ada", age: 36 });
  });
});

describe("parseMarkdownTable", () => {
  it("drops the separator row and strips edge pipes", () => {
    const grid = parseMarkdownTable("| a | b |\n| :-- | --: |\n| 1 | 2 |");
    expect(grid).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("honors escaped pipes", () => {
    const grid = parseMarkdownTable("| a | b |\n|---|---|\n| x\\|y | z |");
    expect(grid[1]).toEqual(["x|y", "z"]);
  });
});

describe("tabularToJson — Markdown", () => {
  it("parses a Markdown table into typed rows", () => {
    const r = tabularToJson("| name | age |\n|------|-----|\n| Ada | 36 |");
    expect(r.ok).toBe(true);
    expect(r.format).toBe("markdown");
    expect(r.rows[0]).toEqual({ name: "Ada", age: 36 });
  });
});

describe("inferCell", () => {
  it("infers integer, number, boolean, null, string", () => {
    expect(inferCell("36")).toEqual({ value: 36, type: "integer" });
    expect(inferCell("3.14")).toEqual({ value: 3.14, type: "number" });
    expect(inferCell("true")).toEqual({ value: true, type: "boolean" });
    expect(inferCell("")).toEqual({ value: null, type: "null" });
    expect(inferCell("hello")).toEqual({ value: "hello", type: "string" });
  });
  it("preserves leading-zero identifiers as strings", () => {
    expect(inferCell("007")).toEqual({ value: "007", type: "string" });
  });
  it("keeps integers beyond Number.MAX_SAFE_INTEGER as strings (no precision loss)", () => {
    expect(inferCell("9999999999999999")).toEqual({ value: "9999999999999999", type: "string" });
  });
});

describe("columnType", () => {
  it("unifies integer+number to number", () => {
    expect(columnType(["integer", "number"])).toBe("number");
  });
  it("returns string for mixed string+integer", () => {
    expect(columnType(["string", "integer"])).toBe("string");
  });
  it("ignores nulls when unifying", () => {
    expect(columnType(["integer", "null", "integer"])).toBe("integer");
  });
});

describe("normalizeHeaders", () => {
  it("synthesizes names for blanks and dedupes duplicates", () => {
    expect(normalizeHeaders(["a", "a", ""], 3)).toEqual(["a", "a_2", "column_3"]);
  });
  it("synthesizes all names when there is no header row", () => {
    expect(normalizeHeaders(null, 2)).toEqual(["column_1", "column_2"]);
  });
  it("produces unique keys when a synthesized name collides with an existing column", () => {
    const out = normalizeHeaders(["a", "a_2", "a"], 3);
    expect(new Set(out).size).toBe(3);
    expect(out).toEqual(["a", "a_2", "a_3"]);
  });
});

describe("looksLikeHeader", () => {
  it("true when first row is text and data has typed cells", () => {
    expect(looksLikeHeader(["name", "age"], [["Ada", "36"]])).toBe(true);
  });
  it("false when the first row already contains numbers", () => {
    expect(looksLikeHeader(["1", "2"], [["3", "4"]])).toBe(false);
  });
});

describe("tabularToJson — header handling", () => {
  it("synthesizes column_N when there is no header", () => {
    const r = tabularToJson("1,2,3\n4,5,6", { hasHeader: "false" });
    expect(r.ok).toBe(true);
    expect(r.columns.map((c) => c.name)).toEqual(["column_1", "column_2", "column_3"]);
    expect(r.rows[0]).toEqual({ column_1: 1, column_2: 2, column_3: 3 });
  });
});

describe("tabularToJson — schema", () => {
  const schema: Record<string, unknown> = {
    type: "object",
    properties: { age: { type: "integer" }, name: { type: "string" } },
    required: ["age", "name"],
  };

  it("validates each row against a schema", () => {
    const r = tabularToJson("name,age\nAda,36", { schema });
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toEqual({ name: "Ada", age: 36 });
  });

  it("reports a failing row with its index", () => {
    const schemaMin: Record<string, unknown> = {
      type: "object",
      properties: { age: { type: "integer", minimum: 18 } },
      required: ["age"],
    };
    const r = tabularToJson("name,age\nAda,36\nKid,5", { schema: schemaMin });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/Row 2/);
  });
});

describe("tabularToJson — unparseable", () => {
  it("returns ok:false for empty input", () => {
    const r = tabularToJson("   ");
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.columns).toEqual([]);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("keeps cells as strings when inferTypes is false", () => {
    const r = tabularToJson("a,b\n1,2", { inferTypes: false });
    expect(r.ok).toBe(true);
    expect(r.columns.every((c) => c.type === "string")).toBe(true);
    expect(r.rows[0]).toEqual({ a: "1", b: "2" });
  });
});
