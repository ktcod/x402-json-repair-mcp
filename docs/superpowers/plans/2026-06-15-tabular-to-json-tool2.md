# Tool #2 `tabular_to_json` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second pure-logic MCP tool, `tabular_to_json`, that turns messy CSV/TSV/Markdown-table text into clean, typed JSON rows with structured diagnostics, gated by x402 at $0.03/call.

**Architecture:** A new tool module `src/tools/tabularToJson.ts` plugs into the existing tool-agnostic core via a one-line add to `src/tools/index.ts` (which auto-wires MCP registration, x402 gating, the 402 envelope, and Bazaar discovery). The JSON-Schema validate+coerce logic currently inlined in `src/tools/structuredJsonRepair.ts` is first extracted into a shared `src/tools/schemaValidate.ts` so both tools reuse it (DRY). CSV/TSV parsing uses Papa Parse (pure-JS, Workers-safe); Markdown tables use a small hand-written parser.

**Tech Stack:** TypeScript (NodeNext, strict), `papaparse` + `@types/papaparse`, `@cfworker/json-schema` (existing), `zod` (existing), MCP SDK `registerTool`, vitest.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/tools/schemaValidate.ts` (**create**) | Shared, pure JSON-Schema validate + type-coerce helpers extracted from tool #1: `isSchemaObject`, `jsonTypeOf`, `coerceToSchema`, `formatSchemaError`, `validateAndCoerce`. No MCP/HTTP deps. |
| `src/tools/structuredJsonRepair.ts` (**modify**) | Tool #1. Import the schema helpers from `schemaValidate.ts` instead of defining them inline; re-export `coerceToSchema` (its test imports it from here). Public behavior unchanged. |
| `src/tools/tabularToJson.ts` (**create**) | Tool #2. Pure parsing/typing functions (`detectFormat`, `parseDelimited`, `parseMarkdownTable`, `inferCell`, `columnType`, `normalizeHeaders`, `looksLikeHeader`, `tabularToJson`) + Zod I/O schemas + the `ToolModule` export with compact Bazaar `discovery`. |
| `src/tools/index.ts` (**modify**) | Append `tabularToJsonTool` to the `tools` array. |
| `test/schemaValidate.test.ts` (**create**) | Focused tests for the extracted helper. |
| `test/tabularToJson.test.ts` (**create**) | Unit tests for parsing, headers, type inference, schema, unparseable input. |
| `package.json` (**modify**) | Add `papaparse` (deps) + `@types/papaparse` (devDeps). |

DRY: schema logic lives in exactly one place after Task 2. YAGNI: no HTML/xlsx/multi-table support (explicit non-goals). TDD: every behavior gets a failing test first.

---

## Task 1: Add the Papa Parse dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the runtime + types packages**

Run:
```bash
cd ~/projects/x402-json-repair-mcp
npm install papaparse@^5.4.1
npm install -D @types/papaparse@^5.3.14
```

- [ ] **Step 2: Verify they landed in the right dependency groups**

Run: `node -e "const p=require('./package.json'); console.log('dep', p.dependencies.papaparse, '| dev', p.devDependencies['@types/papaparse'])"`
Expected: `dep ^5.4.1 | dev ^5.3.14` (papaparse is a RUNTIME dep — it must NOT be under devDependencies).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add papaparse for tabular_to_json (tool #2)"
```

---

## Task 2: Extract shared JSON-Schema validate/coerce into `schemaValidate.ts`

This is a refactor with no behavior change for tool #1. We move the schema helpers out, add a combined `validateAndCoerce`, point tool #1 at them, and confirm tool #1's existing tests still pass.

**Files:**
- Create: `src/tools/schemaValidate.ts`
- Modify: `src/tools/structuredJsonRepair.ts`
- Create: `test/schemaValidate.test.ts`

- [ ] **Step 1: Create `src/tools/schemaValidate.ts`**

```typescript
import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";

export type JsonType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isSchemaObject(s: unknown): s is Schema {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

export function jsonTypeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "string") return "string";
  return "object";
}

function coercePrimitive(value: unknown, target: JsonType): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const s = value.trim();
    if ((target === "number" || target === "integer") && s !== "" && Number.isFinite(Number(s))) {
      const n = Number(s);
      if (target === "integer" && !Number.isInteger(n)) return { value, changed: false };
      return { value: n, changed: true };
    }
    if (target === "boolean" && /^(true|false)$/i.test(s)) {
      return { value: s.toLowerCase() === "true", changed: true };
    }
  }
  if ((typeof value === "number" || typeof value === "boolean") && target === "string") {
    return { value: String(value), changed: true };
  }
  return { value, changed: false };
}

/** Coerce primitive values to match a JSON Schema's declared types. Records each change. */
export function coerceToSchema(root: unknown, schema: Schema): { value: unknown; coercions: string[] } {
  const coercions: string[] = [];

  function walk(value: unknown, sch: unknown, path: string): unknown {
    if (!isSchemaObject(sch)) return value;
    const type = sch.type;

    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (type === "object" || (type === undefined && sch.properties))
    ) {
      const props = (sch.properties ?? {}) as Record<string, unknown>;
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(props)) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          obj[key] = walk(obj[key], props[key], `${path}/${key}`);
        }
      }
      return obj;
    }

    if (Array.isArray(value) && (type === "array" || (type === undefined && sch.items))) {
      const items = sch.items;
      if (isSchemaObject(items)) {
        return value.map((el, i) => walk(el, items, `${path}/${i}`));
      }
      return value;
    }

    const candidates: JsonType[] = Array.isArray(type)
      ? (type as JsonType[])
      : type
        ? [type as JsonType]
        : [];
    for (const target of candidates) {
      const result = coercePrimitive(value, target);
      if (result.changed) {
        coercions.push(
          `Coerced ${path || "/"} from ${jsonTypeOf(value)} to ${target} (${JSON.stringify(value)} → ${JSON.stringify(result.value)}).`,
        );
        return result.value;
      }
    }
    return value;
  }

  const value = walk(root, schema, "");
  return { value, coercions };
}

export function formatSchemaError(unit: OutputUnit): string {
  const where = unit.instanceLocation && unit.instanceLocation !== "#" ? unit.instanceLocation : "/";
  return `Schema validation failed at ${where}: ${unit.error} (${unit.keyword}).`;
}

export interface SchemaCheckResult {
  ok: boolean;
  data: unknown;
  changed: boolean;
  errors: string[];
  repairs: string[];
}

/**
 * Validate `value` against a JSON Schema (draft 2020-12), optionally coercing primitives first.
 * Pure and deterministic. Used by both structured_json_repair and tabular_to_json.
 */
export function validateAndCoerce(
  value: unknown,
  schema: Record<string, unknown>,
  coerce = true,
): SchemaCheckResult {
  const errors: string[] = [];
  const repairs: string[] = [];
  let changed = false;
  let data = value;

  if (!isSchemaObject(schema)) {
    return { ok: false, data, changed, errors: ["`schema` must be a JSON Schema object."], repairs };
  }

  let validator: Validator;
  try {
    validator = new Validator(schema as Schema, "2020-12", false);
  } catch (e) {
    return { ok: false, data, changed, errors: [`Invalid JSON Schema provided: ${errMessage(e)}.`], repairs };
  }

  if (coerce) {
    const { value: coerced, coercions } = coerceToSchema(data, schema as Schema);
    if (coercions.length > 0) {
      data = coerced;
      changed = true;
      repairs.push(...coercions);
    }
  }

  const result = validator.validate(data);
  if (!result.valid) {
    errors.push(...result.errors.map(formatSchemaError));
    return { ok: false, data, changed, errors, repairs };
  }
  return { ok: true, data, changed, errors, repairs };
}
```

- [ ] **Step 2: Write the failing test `test/schemaValidate.test.ts`**

```typescript
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
```

- [ ] **Step 3: Run the new test to verify it fails**

Run: `npx vitest run test/schemaValidate.test.ts`
Expected: FAIL — `Cannot find module '../src/tools/schemaValidate.js'` (until Step 1's file is saved). If Step 1 was already saved, it should PASS; that's fine — proceed.

- [ ] **Step 4: Refactor `src/tools/structuredJsonRepair.ts` to use the shared helper**

Replace the top imports. Change:

```typescript
import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
```

to:

```typescript
import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { coerceToSchema, isSchemaObject, validateAndCoerce } from "./schemaValidate.js";

// Re-export for backward compatibility (test/structuredJsonRepair.test.ts imports it from here).
export { coerceToSchema };
```

- [ ] **Step 5: Delete the now-moved helpers from `structuredJsonRepair.ts`**

Delete these declarations from `structuredJsonRepair.ts` (they now live in `schemaValidate.ts`):
- the `type JsonType = ...` line
- `function isSchemaObject(...)` (now imported)
- `function jsonTypeOf(...)`
- `function coercePrimitive(...)`
- `export function coerceToSchema(...)` (now imported + re-exported)
- `function formatSchemaError(...)`

KEEP: `errMessage`, `stripCodeFences`, `describeSyntaxRepairs`, `repairJson`, the Zod schemas, `DESCRIPTION`, and `structuredJsonRepairTool`.

- [ ] **Step 6: Replace the schema block inside `repairJson`**

In `repairJson`, replace this block:

```typescript
  if (schema !== undefined && schema !== null) {
    if (!isSchemaObject(schema)) {
      errors.push("`schema` must be a JSON Schema object.");
      return { ok: false, data: parsed, changed, errors, repairs };
    }
    let validator: Validator;
    try {
      validator = new Validator(schema, "2020-12", false);
    } catch (e) {
      errors.push(`Invalid JSON Schema provided: ${errMessage(e)}.`);
      return { ok: false, data: parsed, changed, errors, repairs };
    }

    if (coerce) {
      const { value, coercions } = coerceToSchema(parsed, schema);
      if (coercions.length > 0) {
        parsed = value;
        changed = true;
        repairs.push(...coercions);
      }
    }

    const result = validator.validate(parsed);
    if (!result.valid) {
      errors.push(...result.errors.map(formatSchemaError));
      return { ok: false, data: parsed, changed, errors, repairs };
    }
  }
```

with:

```typescript
  if (schema !== undefined && schema !== null) {
    const check = validateAndCoerce(parsed, schema, coerce);
    parsed = check.data;
    if (check.repairs.length > 0) {
      repairs.push(...check.repairs);
      changed = true;
    }
    if (!check.ok) {
      errors.push(...check.errors);
      return { ok: false, data: parsed, changed, errors, repairs };
    }
  }
```

Note: `isSchemaObject` stays imported because it is still referenced nowhere else in this file after the refactor — if `npm run typecheck` flags it as an unused import, remove it from the import line in Step 4. (It is imported defensively in case a future edit needs it; an unused-import error is the signal to drop it.)

- [ ] **Step 7: Run the full test suite — tool #1 behavior must be unchanged**

Run: `npx vitest run test/structuredJsonRepair.test.ts test/schemaValidate.test.ts`
Expected: PASS — all existing `structuredJsonRepair` tests green (the refactor preserves behavior) AND the new `schemaValidate` tests green.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If an unused-import error fires for `isSchemaObject` or `coerceToSchema`, apply the Step 6 note / confirm the re-export line is present.)

- [ ] **Step 9: Commit**

```bash
git add src/tools/schemaValidate.ts src/tools/structuredJsonRepair.ts test/schemaValidate.test.ts
git commit -m "refactor: extract shared JSON-Schema validate/coerce into schemaValidate.ts"
```

---

## Task 3: Write the failing tests for `tabular_to_json`

Write the full behavior spec as tests first. The module does not exist yet, so these fail to import.

**Files:**
- Create: `test/tabularToJson.test.ts`

- [ ] **Step 1: Create `test/tabularToJson.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/tabularToJson.test.ts`
Expected: FAIL — `Cannot find module '../src/tools/tabularToJson.js'`.

---

## Task 4: Implement `src/tools/tabularToJson.ts`

**Files:**
- Create: `src/tools/tabularToJson.ts`

- [ ] **Step 1: Create the module**

```typescript
import { z } from "zod";
import Papa from "papaparse";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { isSchemaObject, validateAndCoerce, type JsonType } from "./schemaValidate.js";

export const TOOL_NAME = "tabular_to_json";
export const TOOL_PRICE = "$0.03";

export type TabularFormat = "csv" | "tsv" | "markdown";

export interface TabularColumn {
  name: string;
  type: JsonType;
}

export interface TabularResult {
  ok: boolean;
  format: TabularFormat;
  columns: TabularColumn[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  changed: boolean;
  errors: string[];
  repairs: string[];
}

export interface TabularOptions {
  format?: "auto" | TabularFormat;
  hasHeader?: "auto" | "true" | "false";
  inferTypes?: boolean;
  schema?: Record<string, unknown>;
}

interface Cell {
  value: unknown;
  type: JsonType;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Split one Markdown table row on unescaped pipes, dropping the artifacts of leading/trailing pipes. */
function splitMarkdownCells(line: string): string[] {
  const parts = line.split(/(?<!\\)\|/);
  if (parts.length > 0 && parts[0].trim() === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === "") parts.pop();
  return parts.map((p) => p.replace(/\\\|/g, "|").trim());
}

/** A Markdown table separator row: every cell is dashes with optional alignment colons. */
function isMarkdownSeparator(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitMarkdownCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

export function detectFormat(text: string): TabularFormat {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (lines.length === 0) return "csv";
  const hasPipes = lines.some((l) => l.includes("|"));
  if (hasPipes && lines.some((l) => isMarkdownSeparator(l))) return "markdown";
  if (lines[0].includes("\t")) return "tsv";
  return "csv";
}

export function parseDelimited(text: string, delimiter?: string): string[][] {
  const result = Papa.parse<string[]>(stripBom(text), {
    delimiter: delimiter ?? "",
    skipEmptyLines: "greedy",
    newline: "",
  });
  return (result.data as string[][]).map((row) => row.map((c) => (c == null ? "" : String(c))));
}

export function parseMarkdownTable(text: string): string[][] {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const rows: string[][] = [];
  for (const line of lines) {
    if (isMarkdownSeparator(line)) continue;
    rows.push(splitMarkdownCells(line));
  }
  return rows;
}

export function inferCell(raw: string): Cell {
  const s = raw.trim();
  if (s === "") return { value: null, type: "null" };
  if (/^(true|false)$/i.test(s)) return { value: s.toLowerCase() === "true", type: "boolean" };
  // Preserve leading-zero identifiers (zip codes, IDs) as strings.
  if (/^[+-]?0\d/.test(s)) return { value: s, type: "string" };
  if (/^[+-]?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return { value: n, type: "integer" };
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) && Number.isFinite(Number(s))) {
    return { value: Number(s), type: "number" };
  }
  return { value: s, type: "string" };
}

/** The unified column type across its cell types (nulls ignored; integer+number => number; mixed => string). */
export function columnType(types: JsonType[]): JsonType {
  const nonNull = types.filter((t) => t !== "null");
  if (nonNull.length === 0) return "null";
  const uniq = [...new Set(nonNull)];
  if (uniq.length === 1) return uniq[0];
  if (uniq.every((t) => t === "integer" || t === "number")) return "number";
  return "string";
}

export function normalizeHeaders(headerRow: string[] | null, columnCount: number): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < columnCount; i++) {
    let name = headerRow && headerRow[i] !== undefined ? String(headerRow[i]).trim() : "";
    if (name === "") name = `column_${i + 1}`;
    const count = seen.get(name);
    if (count !== undefined) {
      const next = count + 1;
      seen.set(name, next);
      name = `${name}_${next}`;
    } else {
      seen.set(name, 1);
    }
    out.push(name);
  }
  return out;
}

export function looksLikeHeader(firstRow: string[], dataRows: string[][]): boolean {
  const isTyped = (s: string): boolean => {
    const { type } = inferCell(s);
    return type === "integer" || type === "number" || type === "boolean";
  };
  const firstAllText = firstRow.length > 0 && firstRow.every((c) => c.trim() !== "" && !isTyped(c));
  if (!firstAllText) return false;
  return dataRows.some((r) => r.some((c) => isTyped(c)));
}

function emptyResult(format: TabularFormat, changed: boolean, errors: string[], repairs: string[]): TabularResult {
  return { ok: false, format, columns: [], rows: [], rowCount: 0, changed, errors, repairs };
}

/**
 * Pure, deterministic tabular-text → typed JSON rows. No network, no LLM, no side effects.
 */
export function tabularToJson(input: string, opts: TabularOptions = {}): TabularResult {
  const repairs: string[] = [];
  const errors: string[] = [];
  let changed = false;

  if (typeof input !== "string" || input.trim() === "") {
    return emptyResult(
      "csv",
      false,
      ["`input` must be a non-empty string containing tabular text (CSV, TSV, or a Markdown table)."],
      [],
    );
  }

  const text = stripBom(input);
  if (text !== input) {
    repairs.push("Stripped a leading byte-order mark (BOM).");
    changed = true;
  }

  const requested = opts.format ?? "auto";
  const format: TabularFormat = requested === "auto" ? detectFormat(text) : requested;
  if (requested === "auto") repairs.push(`Detected '${format}' format.`);

  let grid: string[][];
  try {
    grid =
      format === "markdown"
        ? parseMarkdownTable(text)
        : format === "tsv"
          ? parseDelimited(text, "\t")
          : parseDelimited(text);
  } catch (e) {
    return emptyResult(format, changed, [`Could not parse the input as ${format}: ${errMessage(e)}.`], repairs);
  }

  grid = grid.filter((r) => r.length > 0 && !(r.length === 1 && r[0].trim() === ""));
  if (grid.length === 0) {
    return emptyResult(format, changed, ["No rows found in the input."], repairs);
  }

  const columnCount = Math.max(...grid.map((r) => r.length));

  const wantHeader = opts.hasHeader ?? "auto";
  let headerRow: string[] | null = null;
  let dataRows: string[][];
  if (wantHeader === "true") {
    headerRow = grid[0];
    dataRows = grid.slice(1);
  } else if (wantHeader === "false") {
    dataRows = grid;
  } else if (grid.length >= 2 && looksLikeHeader(grid[0], grid.slice(1))) {
    headerRow = grid[0];
    dataRows = grid.slice(1);
    repairs.push("Treated the first row as a header (auto-detected).");
  } else {
    dataRows = grid;
  }

  const headers = normalizeHeaders(headerRow, columnCount);

  let padded = 0;
  let truncated = 0;
  const squared = dataRows.map((r) => {
    if (r.length < columnCount) {
      padded++;
      return [...r, ...Array<string>(columnCount - r.length).fill("")];
    }
    if (r.length > columnCount) {
      truncated++;
      return r.slice(0, columnCount);
    }
    return r;
  });
  if (padded > 0) {
    repairs.push(`Padded ${padded} ragged row(s) with empty cells to ${columnCount} column(s).`);
    changed = true;
  }
  if (truncated > 0) {
    repairs.push(`Truncated ${truncated} over-long row(s) to ${columnCount} column(s).`);
    changed = true;
  }

  const inferTypes = opts.inferTypes ?? true;
  const cellGrid: Cell[][] = squared.map((r) =>
    r.map((c) => (inferTypes ? inferCell(c) : ({ value: c.trim(), type: "string" } as Cell))),
  );

  const columns: TabularColumn[] = headers.map((name, ci) => {
    const types = cellGrid.map((row) => row[ci]?.type ?? "null");
    return { name, type: inferTypes ? columnType(types) : "string" };
  });
  if (inferTypes && columns.some((c) => c.type !== "string")) changed = true;

  const rows: Array<Record<string, unknown>> = cellGrid.map((row) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((name, ci) => {
      const cell = row[ci] ?? ({ value: null, type: "null" } as Cell);
      const colType = columns[ci].type;
      if (cell.type === "null") {
        obj[name] = null;
      } else if (!inferTypes || colType === "string") {
        obj[name] = typeof cell.value === "string" ? cell.value : String(cell.value);
      } else {
        obj[name] = cell.value;
      }
    });
    return obj;
  });

  if (opts.schema !== undefined && opts.schema !== null) {
    if (!isSchemaObject(opts.schema)) {
      errors.push("`schema` must be a JSON Schema object.");
      return { ok: false, format, columns, rows, rowCount: rows.length, changed, errors, repairs };
    }
    let anyFail = false;
    rows.forEach((row, i) => {
      const check = validateAndCoerce(row, opts.schema as Record<string, unknown>, true);
      rows[i] = check.data as Record<string, unknown>;
      if (check.repairs.length > 0) changed = true;
      if (!check.ok) {
        anyFail = true;
        errors.push(...check.errors.map((e) => `Row ${i + 1}: ${e}`));
      }
    });
    if (anyFail) {
      return { ok: false, format, columns, rows, rowCount: rows.length, changed, errors, repairs };
    }
    repairs.push(`Validated ${rows.length} row(s) against the provided JSON Schema.`);
  }

  return { ok: true, format, columns, rows, rowCount: rows.length, changed, errors, repairs };
}

const DESCRIPTION = `Convert messy tabular text into clean, typed JSON rows. Auto-detects CSV, TSV, or a Markdown table and returns one JSON object per row plus an inferred column/type summary. Pure deterministic compute — no network or model calls.

What it handles: delimiter sniffing (comma/semicolon/tab/pipe), quoted fields with embedded commas and newlines, BOM, ragged rows (padded/truncated), Markdown separator rows and escaped pipes, header auto-detection, and per-column type inference (integer/number/boolean/null/string).

When to use: you have CSV/TSV/Markdown-table text (often emitted by tools or LLMs) and want structured, typed rows — optionally validated/coerced against a JSON Schema.

When NOT to use: the data is already clean JSON, or it is HTML/xlsx/binary (not supported).

Args:
  - input (string, required): raw tabular text.
  - format ("auto"|"csv"|"tsv"|"markdown", default "auto"): force a format or auto-detect.
  - hasHeader ("auto"|"true"|"false", default "auto"): whether the first row is a header.
  - inferTypes (boolean, default true): coerce cells to number/integer/boolean/null; else keep strings.
  - schema (object, optional): JSON Schema (draft 2020-12) to validate/coerce each row object against.

Returns structuredContent:
  {
    "ok": boolean,                 // false if the input cannot be parsed as a table
    "format": "csv"|"tsv"|"markdown",
    "columns": [{ "name": string, "type": string }],
    "rows": [{ ... }],             // one object per row, keyed by column name
    "rowCount": number,
    "changed": boolean,            // true if any normalization/coercion happened
    "errors": string[],            // actionable messages when ok is false
    "repairs": string[]            // description of each normalization applied
  }`;

const inputSchema = {
  input: z
    .string()
    .min(1, "`input` must not be empty.")
    .describe("Raw tabular text: a CSV/TSV block or a Markdown table."),
  format: z
    .enum(["auto", "csv", "tsv", "markdown"])
    .default("auto")
    .describe("Force a parser or auto-detect (default 'auto')."),
  hasHeader: z
    .enum(["auto", "true", "false"])
    .default("auto")
    .describe("Whether the first row is a header. 'auto' uses a heuristic."),
  inferTypes: z
    .boolean()
    .default(true)
    .describe("When true (default), infer cell types (number/integer/boolean/null); else keep strings."),
  schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional JSON Schema (draft 2020-12) to validate/coerce each row object against."),
};

const outputSchema = {
  ok: z.boolean().describe("True if the input parsed as a table (and every row is schema-valid when a schema was given)."),
  format: z.enum(["csv", "tsv", "markdown"]).describe("The detected/used format."),
  columns: z
    .array(z.object({ name: z.string(), type: z.string() }))
    .describe("Inferred column names and types."),
  rows: z.array(z.record(z.string(), z.unknown())).describe("One JSON object per data row, keyed by column name."),
  rowCount: z.number().describe("Number of data rows returned."),
  changed: z.boolean().describe("True if any normalization or coercion changed the input."),
  errors: z.array(z.string()).describe("Actionable error messages when ok is false (empty when ok is true)."),
  repairs: z.array(z.string()).describe("Human-readable description of each normalization applied."),
};

export const tabularToJsonTool: ToolModule = {
  name: TOOL_NAME,
  title: "Tabular to JSON",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Raw CSV/TSV/Markdown-table text." },
        format: { type: "string", enum: ["auto", "csv", "tsv", "markdown"], description: "Force or auto-detect format." },
        hasHeader: { type: "string", enum: ["auto", "true", "false"], description: "Whether row 1 is a header." },
        inferTypes: { type: "boolean", description: "Infer cell types (default true)." },
        schema: { type: "object", description: "Optional JSON Schema to validate/coerce each row." },
      },
      required: ["input"],
    },
    output: {
      example: {
        ok: true,
        format: "csv",
        columns: [
          { name: "name", type: "string" },
          { name: "age", type: "integer" },
        ],
        rows: [{ name: "Ada", age: 36 }],
        rowCount: 1,
        changed: true,
        errors: [],
        repairs: ["Detected 'csv' format.", "Inferred column 'age' as integer."],
      },
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          format: { type: "string" },
          columns: { type: "array" },
          rows: { type: "array" },
          rowCount: { type: "number" },
          changed: { type: "boolean" },
          errors: { type: "array" },
          repairs: { type: "array" },
        },
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "Tabular to JSON",
        description: DESCRIPTION,
        inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ input, format, hasHeader, inferTypes, schema }) => {
        const result = tabularToJson(input, { format, hasHeader, inferTypes, schema });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
```

- [ ] **Step 2: Run the tool #2 tests**

Run: `npx vitest run test/tabularToJson.test.ts`
Expected: PASS — all `tabularToJson` tests green.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If Papa's default import errors under NodeNext (`Module can only be default-imported using esModuleInterop`), it should not — `esModuleInterop: true` is set in `tsconfig.json`. If it still complains, switch the import to `import * as Papa from "papaparse";` and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/tools/tabularToJson.ts test/tabularToJson.test.ts
git commit -m "feat: add tabular_to_json tool (CSV/TSV/Markdown -> typed JSON rows)"
```

---

## Task 5: Register the tool in the core

**Files:**
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Add the import and append to the registry**

In `src/tools/index.ts`, after the existing tool import add:

```typescript
import { tabularToJsonTool } from "./tabularToJson.js";
```

and change:

```typescript
export const tools: ToolModule[] = [structuredJsonRepairTool];
```

to:

```typescript
export const tools: ToolModule[] = [structuredJsonRepairTool, tabularToJsonTool];
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all suites green (`structuredJsonRepair`, `schemaValidate`, `tabularToJson`, `paywall`).

- [ ] **Step 3: Confirm the paywall now gates two tools**

Run: `node --input-type=module -e "import('./src/config.js').then(async (m)=>{const {paidToolSpecs}=await import('./src/tools/index.js');console.log(paidToolSpecs().map(t=>t.name+' @ '+t.defaultPrice));})" 2>/dev/null || npx tsx -e "import {paidToolSpecs} from './src/tools/index.js'; console.log(paidToolSpecs().map(t=>t.name+' @ '+t.defaultPrice));"`
Expected: `[ 'structured_json_repair @ $0.01', 'tabular_to_json @ $0.03' ]`

- [ ] **Step 4: Commit**

```bash
git add src/tools/index.ts
git commit -m "feat: register tabular_to_json in the tool registry"
```

---

## Task 6: Build verification

**Files:** none (verification only)

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: clean compile; `dist/tools/tabularToJson.js` and `dist/tools/schemaValidate.js` exist.

- [ ] **Step 2: Smoke-test the built tool over the Node entry**

Run:
```bash
PAYOUT_WALLET_ADDRESS=0xe22F691ed420143BfdAB022A14e7d6873b33EEf9 node dist/node.js &
SERVER_PID=$!
sleep 1
curl -s -X POST http://localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o 'tabular_to_json'
kill $SERVER_PID
```
Expected: prints `tabular_to_json` (the tool is listed). The unpaid `tools/call` path returning HTTP 402 is already covered by `test/paywall.test.ts`.

- [ ] **Step 3: Commit (if build produced lockfile/config changes only — otherwise skip)**

No commit expected here unless `npm run build` altered tracked files.

---

## Task 7: Deploy the new revision + no-funds self-test

This mirrors the tool #1 deploy path (Azure Container Apps, `az acr build` + `az containerapp update`). Use the same RG/ACR/app from the project memory note: RG `x402-mcp-rg`, ACR `ca3a49fc11beacr`, app `x402-json-repair-mcp` (West US 2), SP `claude-agent`.

**Files:** none (deploy only)

- [ ] **Step 1: Build + push the new image (v5)**

Run:
```bash
az acr build --registry ca3a49fc11beacr --image x402-json-repair-mcp:v5 ~/projects/x402-json-repair-mcp
```
Expected: build succeeds, image `:v5` pushed.

- [ ] **Step 2: Roll the Container App to `:v5`**

Run:
```bash
az containerapp update --name x402-json-repair-mcp --resource-group x402-mcp-rg \
  --image ca3a49fc11beacr.azurecr.io/x402-json-repair-mcp:v5
```
Expected: a new revision provisions and becomes active. (Do NOT run concurrently with a `hostname bind`.)

- [ ] **Step 3: Confirm both tools list on the live endpoint**

Run:
```bash
curl -s -X POST https://x402.agentfund.net/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | grep -o -E 'structured_json_repair|tabular_to_json' | sort -u
```
Expected: both `structured_json_repair` and `tabular_to_json`.

- [ ] **Step 4: Confirm `tabular_to_json` is gated at $0.03 (unpaid call → 402)**

Run:
```bash
curl -s -i -X POST https://x402.agentfund.net/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tabular_to_json","arguments":{"input":"a,b\n1,2"}}}' \
  | grep -iE 'HTTP/|payment-required'
```
Expected: `HTTP/2 402` plus a `payment-required` header. Decode the header (base64 JSON) and confirm the amount is `30000` (= $0.03 at 6-decimal USDC) on `eip155:8453`, asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

- [ ] **Step 5: No-funds self-test (proves the payment path accepts the new tool's payload through CDP)**

Run the buyer test client against `tabular_to_json` with an ephemeral, unfunded wallet (reuse `scripts/pay-test.mjs`, pointing it at the new tool / arguments). Read the facilitator's reject reason:
- `insufficient_balance` / `execution reverted` ⇒ payload FORMAT is accepted (a funded wallet would settle) — PASS.
- `must match one of [x402V2Pay...]` ⇒ payload format rejected — FAIL; inspect the `resource.description` / discovery metadata size as in the tool #1 fix.

Expected: a funds-only rejection (PASS). No real funds are spent.

- [ ] **Step 6: Update the project memory note**

Append to `~/.claude/projects/-Users-kennethta/memory/personal/x402_json_repair_mcp.md`: tool #2 `tabular_to_json` shipped at $0.03, live revision/image `:v5`, both tools listed + gated, no-funds self-test result.

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-15-tabular-to-json-tool2-design.md`):
- CSV/TSV quotes, embedded newlines, delimiter sniffing, BOM, ragged rows → Task 3 tests + Task 4 `parseDelimited`/squaring. ✓
- Markdown escaped pipes, separator row, leading/trailing pipes, ragged → `parseMarkdownTable`/`splitMarkdownCells`/`isMarkdownSeparator`. ✓
- Auto-detect format → `detectFormat`. ✓
- Type inference integer/number/boolean/null/string, mixed ⇒ string → `inferCell`/`columnType`. ✓
- Header auto-detection + synthesized `column_N` + dedupe → `looksLikeHeader`/`normalizeHeaders`. ✓
- Optional schema validate/coerce per row via shared helper → Task 2 `validateAndCoerce`, Task 4 schema loop. ✓
- Structured diagnostics (`ok/format/columns/rows/rowCount/changed/errors/repairs`) → `TabularResult`. ✓
- Tool contract: name `tabular_to_json`, price `$0.03` (env `PRICE_TABULAR_TO_JSON` via `priceEnvVar`), annotations → `tabularToJsonTool`. ✓
- One-line registry add, no `payments/`/`mcp/`/`index.ts` change → Task 5. ✓
- DRY refactor into `schemaValidate.ts`, tool #1 behavior unchanged → Task 2. ✓
- papaparse runtime + types dev → Task 1. ✓
- Bazaar `discovery` compact metadata → `tabularToJsonTool.discovery`. ✓
- Verification: typecheck/build/vitest + no-funds self-test + both tools listed → Tasks 6–7. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✓

**Type consistency:** `JsonType` is defined once in `schemaValidate.ts` and imported by `tabularToJson.ts`. `TabularResult`/`TabularColumn`/`TabularOptions`/`Cell` are consistent across functions. `validateAndCoerce` signature `(value, schema, coerce)` is used identically in tool #1 (Task 2 Step 6) and tool #2 (Task 4 schema loop). `coerceToSchema` re-exported from tool #1 keeps `test/structuredJsonRepair.test.ts` green. ✓
