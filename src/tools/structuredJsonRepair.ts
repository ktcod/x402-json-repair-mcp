import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";

export const TOOL_NAME = "structured_json_repair";
export const TOOL_PRICE = "$0.01";

export interface RepairResult {
  ok: boolean;
  data: unknown;
  changed: boolean;
  errors: string[];
  repairs: string[];
}

type JsonType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isSchemaObject(s: unknown): s is Schema {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

/** Remove a Markdown code-fence wrapper (```json … ``` or ``` … ```), including a truncated opening fence. */
export function stripCodeFences(input: string): string {
  const trimmed = input.trim();
  const balanced = trimmed.match(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/);
  if (balanced) return balanced[1].trim();
  const openOnly = trimmed.match(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*)$/);
  if (openOnly) return openOnly[1].replace(/```\s*$/, "").trim();
  return input;
}

function describeSyntaxRepairs(text: string): string[] {
  const repairs: string[] = [];
  if (/,\s*[}\]]/.test(text)) repairs.push("Removed trailing comma(s) before a closing } or ].");
  if (/'(?:[^'\\]|\\.)*'/.test(text)) repairs.push("Converted single-quoted strings to double-quoted JSON strings.");
  if (/[{,]\s*[A-Za-z_$][\w$]*\s*:/.test(text)) repairs.push("Added double quotes around unquoted object key(s).");
  if (/\b(None|True|False)\b/.test(text)) repairs.push("Converted Python literals (None/True/False) to JSON null/true/false.");
  if (/\bNaN\b|\b-?Infinity\b/.test(text)) repairs.push("Replaced non-JSON numeric literals (NaN/Infinity).");
  return repairs;
}

function jsonTypeOf(value: unknown): JsonType {
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

function formatSchemaError(unit: OutputUnit): string {
  const where = unit.instanceLocation && unit.instanceLocation !== "#" ? unit.instanceLocation : "/";
  return `Schema validation failed at ${where}: ${unit.error} (${unit.keyword}).`;
}

/**
 * Pure, deterministic JSON repair + optional JSON Schema validation/coercion.
 * No network, no LLM, no side effects.
 */
export function repairJson(input: string, schema?: Record<string, unknown>, coerce = true): RepairResult {
  const errors: string[] = [];
  const repairs: string[] = [];
  let changed = false;

  if (typeof input !== "string") {
    return {
      ok: false,
      data: null,
      changed: false,
      errors: ["`input` must be a string containing JSON-ish text."],
      repairs: [],
    };
  }

  let text = input;
  const defenced = stripCodeFences(text);
  if (defenced !== text) {
    repairs.push("Removed Markdown code-fence wrapper, keeping the JSON inside.");
    text = defenced;
    changed = true;
  }

  let parsed: unknown;
  let parsedOk = false;
  try {
    parsed = JSON.parse(text);
    parsedOk = true;
  } catch {
    // fall through to repair
  }

  if (!parsedOk) {
    let repaired: string;
    try {
      repaired = jsonrepair(text);
    } catch (e) {
      errors.push(
        `Could not repair the input into valid JSON: ${errMessage(e)}. Check for unbalanced brackets/braces or content that was cut off.`,
      );
      return { ok: false, data: null, changed, errors, repairs };
    }
    try {
      parsed = JSON.parse(repaired);
      parsedOk = true;
    } catch (e) {
      errors.push(`Repair produced text that is still not valid JSON: ${errMessage(e)}.`);
      return { ok: false, data: null, changed, errors, repairs };
    }
    changed = true;
    const described = describeSyntaxRepairs(text);
    if (described.length > 0) repairs.push(...described);
    else repairs.push("Normalized malformed JSON syntax (e.g. quoting, commas, or truncation).");
  }

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

  return { ok: true, data: parsed, changed, errors, repairs };
}

const DESCRIPTION = `Repair messy or invalid JSON (the kind LLMs and tools often emit) into clean, valid JSON, and optionally validate/coerce it against a JSON Schema. Pure deterministic compute — no network or model calls.

What it fixes: trailing commas, single-quoted strings, unquoted keys, Python literals (None/True/False), NaN/Infinity, Markdown code-fence wrappers, and truncated/garbled tails.

When to use: you received text that should be JSON but JSON.parse fails, or you have JSON that must conform to a specific schema and want types coerced (e.g. "36" -> 36, "true" -> true).

When NOT to use: the input is already known-valid JSON and no schema check is needed.

Args:
  - input (string, required): the raw/malformed JSON text.
  - schema (object, optional): a JSON Schema (draft 2020-12) to validate and coerce against.
  - coerce (boolean, optional, default true): coerce primitive types to satisfy the schema before validating.

Returns structuredContent:
  {
    "ok": boolean,        // true if valid JSON (and schema-valid when a schema was given)
    "data": any,          // the repaired/validated JSON value; null if unfixable
    "changed": boolean,   // true if any repair or coercion modified the input
    "errors": string[],   // actionable messages when ok is false
    "repairs": string[]   // description of each fix applied
  }`;

const inputSchema = {
  input: z
    .string()
    .min(1, "`input` must not be empty.")
    .describe(
      "Raw or malformed JSON text to repair. Examples: \"{name: 'Ada', age: '36',}\", a ```json fenced block, or a truncated '{\"items\":[1,2,3'.",
    ),
  schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional JSON Schema (draft 2020-12) object to validate and coerce the repaired JSON against."),
  coerce: z
    .boolean()
    .default(true)
    .describe('When true (default), coerce primitives to satisfy the schema before validating (e.g. "36" -> 36).'),
};

const outputSchema = {
  ok: z.boolean().describe("True if the result is valid JSON (and schema-valid when a schema was provided)."),
  data: z.unknown().describe("The repaired/validated JSON value (object, array, or primitive). null when repair failed."),
  changed: z.boolean().describe("True if any repair or coercion changed the input."),
  errors: z.array(z.string()).describe("Actionable error messages when ok is false (empty when ok is true)."),
  repairs: z.array(z.string()).describe("Human-readable description of each repair or coercion applied."),
};

export const structuredJsonRepairTool: ToolModule = {
  name: TOOL_NAME,
  title: "Structured JSON Repair",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Raw/malformed JSON text to repair." },
        schema: { type: "object", description: "Optional JSON Schema to validate/coerce against." },
        coerce: { type: "boolean", description: "Coerce types to fit the schema (default true)." },
      },
      required: ["input"],
    },
    output: {
      example: { ok: true, data: { name: "Ada", age: 36 }, changed: true, errors: [], repairs: [] },
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          data: {},
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
        title: "Structured JSON Repair",
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
      async ({ input, schema, coerce }) => {
        const result = repairJson(input, schema, coerce);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
