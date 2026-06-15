import { describe, it, expect } from "vitest";
import {
  validateAndCoerce,
  coerceToSchema,
  isSchemaObject,
  jsonTypeOf,
} from "../src/tools/schemaValidate.js";
import type { Schema } from "@cfworker/json-schema";

describe("validateAndCoerce", () => {
  const schema: Record<string, unknown> = {
    type: "object",
    properties: { age: { type: "integer" }, name: { type: "string" } },
    required: ["age", "name"],
  };

  it("coerces primitives and passes validation", () => {
    const r = validateAndCoerce({ name: "Ada", age: "36" }, schema, true);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ name: "Ada", age: 36 });
    expect(r.changed).toBe(true);
    expect(r.repairs.join(" ")).toMatch(/Coerced/);
  });

  it("reports a violation when coercion is disabled", () => {
    const r = validateAndCoerce({ name: "Ada", age: "36" }, schema, false);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/age/);
  });

  it("rejects a non-object schema", () => {
    const r = validateAndCoerce({ a: 1 }, [] as unknown as Record<string, unknown>, true);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/JSON Schema object/);
  });

  it("does not throw on an unusual schema", () => {
    const r = validateAndCoerce({ a: 1 }, { type: "frobnicate" }, true);
    expect(typeof r.ok).toBe("boolean");
  });
});

describe("helpers", () => {
  it("jsonTypeOf classifies values", () => {
    expect(jsonTypeOf(null)).toBe("null");
    expect(jsonTypeOf([1])).toBe("array");
    expect(jsonTypeOf(1)).toBe("number");
    expect(jsonTypeOf("x")).toBe("string");
    expect(jsonTypeOf({})).toBe("object");
  });

  it("isSchemaObject rejects arrays and null", () => {
    expect(isSchemaObject({})).toBe(true);
    expect(isSchemaObject([])).toBe(false);
    expect(isSchemaObject(null)).toBe(false);
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
});
