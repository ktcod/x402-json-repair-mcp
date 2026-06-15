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
