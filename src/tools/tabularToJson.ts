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
    // Integers outside the safe range lose precision as JS numbers — keep them as strings
    // rather than falling through to the float branch (which would silently mutate the value).
    return Number.isSafeInteger(n) ? { value: n, type: "integer" } : { value: s, type: "string" };
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
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < columnCount; i++) {
    let base = headerRow && headerRow[i] !== undefined ? String(headerRow[i]).trim() : "";
    if (base === "") base = `column_${i + 1}`;
    // Find a name not already used. The suffix loop also skips collisions with a synthesized
    // name that happens to match an explicit header (e.g. ["a", "a_2", "a"] -> "a_3", not "a_2").
    let name = base;
    let n = 1;
    while (seen.has(name)) {
      n += 1;
      name = `${base}_${n}`;
    }
    seen.add(name);
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
  // Strong signal: data rows have at least one typed (numeric/boolean) cell.
  if (dataRows.some((r) => r.some((c) => isTyped(c)))) return true;
  // Weak signal: every first-row cell looks like a label (non-empty, digit-free, <=64 chars; spaces
  // allowed for multi-word headers) and there is >=1 data row. Catches all-string tables like
  // name,note / Ada,"a, b\nc". A caller can override misdetection with hasHeader:"false".
  const looksLikeName = (s: string): boolean => s.trim().length > 0 && s.trim().length <= 64 && !/\d/.test(s);
  return dataRows.length > 0 && firstRow.every((c) => looksLikeName(c));
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

  // Column count = the header's width when a header defines the schema (so over-long rows are
  // truncated to it); otherwise the widest data row, so nothing is dropped when there is no header.
  const columnCount = headerRow ? headerRow.length : Math.max(...dataRows.map((r) => r.length));

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
      if (check.changed) changed = true;
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
        repairs: ["Detected 'csv' format.", "Treated the first row as a header (auto-detected)."],
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
          // TabularResult has concrete typed fields; the MCP SDK types structuredContent as a
          // plain record, so the double cast is the intended bridge (do not "simplify" it away).
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
