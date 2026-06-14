import { describe, it, expect } from "vitest";
import { repairJson, stripCodeFences, coerceToSchema } from "../src/tools/structuredJsonRepair.js";
import type { Schema } from "@cfworker/json-schema";

describe("repairJson — valid input", () => {
  it("passes valid JSON through unchanged", () => {
    const r = repairJson('{"a":1,"b":[2,3]}');
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.data).toEqual({ a: 1, b: [2, 3] });
    expect(r.errors).toEqual([]);
    expect(r.repairs).toEqual([]);
  });

  it("handles a top-level array", () => {
    const r = repairJson("[1,2,3]");
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([1, 2, 3]);
  });
});

describe("repairJson — malformed input", () => {
  it("removes trailing commas", () => {
    const r = repairJson('{"a":1,}');
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.data).toEqual({ a: 1 });
    expect(r.repairs.join(" ")).toMatch(/trailing comma/i);
  });

  it("fixes single quotes and unquoted keys", () => {
    const r = repairJson("{name: 'Ada', age: 36,}");
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ name: "Ada", age: 36 });
    expect(r.changed).toBe(true);
  });

  it("strips Markdown code fences", () => {
    const r = repairJson("```json\n{\"x\":1}\n```");
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ x: 1 });
    expect(r.repairs.join(" ")).toMatch(/code-fence/i);
  });

  it("converts Python literals", () => {
    const r = repairJson('{"a": None, "b": True, "c": False}');
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ a: null, b: true, c: false });
  });

  it("closes a truncated tail", () => {
    const r = repairJson('{"items":[1,2,3');
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ items: [1, 2, 3] });
    expect(r.changed).toBe(true);
  });
});

describe("repairJson — unfixable input", () => {
  it("reports an actionable error for empty/whitespace input", () => {
    const r = repairJson("   ");
    expect(r.ok).toBe(false);
    expect(r.data).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join(" ")).toMatch(/valid JSON/i);
  });

  it("reports an actionable error for non-JSON content", () => {
    const r = repairJson("<html></html>");
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("repairJson — schema validation & coercion", () => {
  const schema: Record<string, unknown> = {
    type: "object",
    properties: { age: { type: "integer" }, name: { type: "string" } },
    required: ["age", "name"],
  };

  it("coerces primitive types to satisfy the schema", () => {
    const r = repairJson('{"name":"Ada","age":"36"}', schema, true);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ name: "Ada", age: 36 });
    expect(r.changed).toBe(true);
    expect(r.repairs.join(" ")).toMatch(/Coerced/);
  });

  it("reports violations when coercion is disabled", () => {
    const r = repairJson('{"name":"Ada","age":"36"}', schema, false);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join(" ")).toMatch(/age/);
  });

  it("reports missing required fields", () => {
    const r = repairJson('{"name":"Ada"}', schema, true);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/required|age/i);
  });

  it("repairs malformed input and validates against a schema together", () => {
    const r = repairJson("{name:'Ada', age:'36',}", schema, true);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ name: "Ada", age: 36 });
    expect(r.changed).toBe(true);
  });

  it("does not crash on an unusual schema", () => {
    const r = repairJson('{"a":1}', { type: "frobnicate" }, true);
    expect(typeof r.ok).toBe("boolean");
  });
});

describe("helpers", () => {
  it("stripCodeFences handles language tags and bare fences", () => {
    expect(stripCodeFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(stripCodeFences("```\n[1,2]\n```")).toBe("[1,2]");
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });

  it("coerceToSchema coerces nested array items", () => {
    const schema: Schema = {
      type: "object",
      properties: { nums: { type: "array", items: { type: "number" } } },
    };
    const { value, coercions } = coerceToSchema({ nums: ["1", "2", "3"] }, schema);
    expect(value).toEqual({ nums: [1, 2, 3] });
    expect(coercions.length).toBe(3);
  });

  it("coerceToSchema leaves already-correct values unchanged", () => {
    const schema: Schema = { type: "object", properties: { n: { type: "number" } } };
    const { value, coercions } = coerceToSchema({ n: 5 }, schema);
    expect(value).toEqual({ n: 5 });
    expect(coercions.length).toBe(0);
  });
});
