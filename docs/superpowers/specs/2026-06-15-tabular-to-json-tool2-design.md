# Design — Tool #2: `tabular_to_json`

**Date:** 2026-06-15
**Project:** x402-json-repair-mcp (pay-per-call MCP server, USDC on Base via x402)
**Status:** Approved (brainstorm), pending implementation plan

## Summary

Add a second pure-logic, deterministic MCP tool — `tabular_to_json` — that ingests messy
tabular text (CSV, TSV, or a Markdown table; auto-detected) and returns clean, typed JSON
rows plus a column/type summary, with the same structured diagnostics as tool #1
(`structured_json_repair`). It extends the "data-hygiene for AI agents" product line:
tool #1 fixes malformed JSON, tool #2 normalizes messy tabular data into rows.

It is **pure compute** — no model, no paid API — preserving ~100% margin and zero-maintenance,
and it slots into the existing tool-agnostic core (a new tool module + one-line registry add).

## Goals

- Robustly parse real-world **CSV/TSV** (quotes, embedded newlines, delimiter sniffing `, ; \t`,
  encoding/BOM, ragged rows) and **Markdown tables** (escaped pipes, the `---` separator row,
  ragged rows) into clean JSON row objects.
- **Auto-detect** the input format so the caller just passes text.
- **Infer cell types** (number / integer / boolean / null / string) per column.
- Optionally **validate/coerce each row** against a caller-supplied JSON Schema (reusing tool #1's
  validator + coercion).
- Return **structured diagnostics** (`ok`, `errors`, `repairs`, `changed`) mirroring tool #1.
- Stay deterministic and Workers-safe.

## Non-goals (v1)

- HTML `<table>` extraction (needs a Workers-safe HTML parser; fast-follow candidate).
- Binary spreadsheets (`.xlsx`) — not text, needs a heavy lib.
- Multi-table documents / nested tables.
- Any model/LLM or network call.

## Tool contract

**Name:** `tabular_to_json` · **Price:** `$0.03`/call (env override `PRICE_TABULAR_TO_JSON`)
**Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`

### Input (Zod raw shape)

| field | type | default | description |
|-------|------|---------|-------------|
| `input` | string (min 1) | — | Raw tabular text (CSV/TSV/Markdown table). |
| `format` | enum `auto`\|`csv`\|`tsv`\|`markdown` | `auto` | Force a format or auto-detect. |
| `hasHeader` | enum `auto`\|`true`\|`false` | `auto` | Whether the first row is a header (auto = heuristic). |
| `inferTypes` | boolean | `true` | Coerce cells to number/integer/boolean/null; else keep strings. |
| `schema` | object (optional) | — | JSON Schema (draft 2020-12) to validate/coerce each **row object** against. |

(`hasHeader` is a string enum, not boolean, so the caller can request auto-detection explicitly.)

### Output (`structuredContent`)

```jsonc
{
  "ok": true,                 // false if the input can't be parsed as a table
  "format": "csv",            // detected/used format
  "columns": [                // inferred column names + types
    { "name": "name", "type": "string" },
    { "name": "age",  "type": "integer" }
  ],
  "rows": [                   // the data, one object per row (keyed by column name)
    { "name": "Ada", "age": 36 }
  ],
  "rowCount": 1,
  "changed": true,            // any normalization/coercion happened
  "errors": [],               // actionable messages when ok is false
  "repairs": [                // human-readable description of each normalization
    "Detected ';' as the delimiter.",
    "Padded 1 ragged row to 2 columns.",
    "Coerced column 'age' to integer."
  ]
}
```

## Behavior

1. **Detect format** (`format: auto`): Markdown if the text has pipe rows plus a separator row
   matching `^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$`; else TSV if rows are tab-delimited;
   else CSV (delegating delimiter sniffing among `, ; \t |` to the CSV parser).
2. **Parse:**
   - **CSV/TSV** via **Papa Parse** (`papaparse`) — pure-JS, Workers-safe; handles quoting,
     embedded newlines, delimiter detection, and ragged rows. Strip a leading BOM.
   - **Markdown** via a small hand-written deterministic parser: split lines, drop the separator
     row, strip leading/trailing pipes, split on unescaped `|` (honor `\|`), trim cells.
3. **Header handling:** `hasHeader: auto` → heuristic (first row all-non-numeric while data rows
   contain numerics ⇒ header). Build row objects keyed by header names; dedupe blank/duplicate
   headers to `column_1`, `column_2`, …. With no header, synthesize `column_1…N`.
4. **Ragged rows:** pad short rows with `null` / truncate long rows to the column count; record
   counts in `repairs`.
5. **Type inference** (`inferTypes: true`): per cell → integer, number, boolean (`true`/`false`),
   null (empty), else string. A column's `type` is the unified type of its cells (mixed ⇒ `string`).
6. **Optional schema:** if `schema` provided, validate/coerce each row object via the shared
   `schemaValidate` helper (cfworker + coercion). Rows failing validation are reported in `errors`
   (with row index); `ok` is false if any row fails.
7. **Unparseable input** (e.g., not tabular, zero columns) → `ok: false`, `rows: []`,
   `columns: []`, actionable `errors`.

## Architecture & integration

- **New file** `src/tools/tabularToJson.ts` — pure parsing/typing functions + Zod input/output
  schemas + the `ToolModule` export + compact Bazaar `discovery` metadata.
- **Registry:** add `tabularToJsonTool` to the array in `src/tools/index.ts`. That single change
  wires up MCP `registerTool`, x402 gating at `$0.03` (any tool with `price !== null` is auto-gated),
  the 402 envelope, and Bazaar discovery — no changes to `payments/`, `mcp/`, or `index.ts`.
- **DRY refactor:** extract the JSON-Schema validate+coerce logic currently inside
  `structuredJsonRepair.ts` (the `@cfworker/json-schema` `Validator` use + `coerceToSchema`) into a
  new shared module `src/tools/schemaValidate.ts`. Both `structured_json_repair` and
  `tabular_to_json` import it. `structuredJsonRepair.ts` keeps its existing public behavior
  (no contract change).
- **Module boundaries:** `tabularToJson.ts` exposes pure functions (`detectFormat`, `parseCsv`,
  `parseMarkdownTable`, `inferTypes`, `tabularToJson`) independently unit-testable without the
  MCP/HTTP layers; the `ToolModule` is a thin wrapper.

## Dependencies

- Add **`papaparse`** (runtime) + **`@types/papaparse`** (dev). Pure-JS string parsing path is
  Workers-safe (we use `Papa.parse(text, config)`, not the Node file/stream APIs).
- Markdown-table parsing: hand-written, no dependency.
- Reuse **`@cfworker/json-schema`** (already a dependency) via the shared helper.

## Pricing & discovery

- Default `$0.03`; `discovery` metadata (compact `inputSchema` + `output` example/schema) so the
  tool lists in the x402 Bazaar after its first settled payment, consistent with tool #1.

## Testing

Unit tests (`test/tabularToJson.test.ts`):
- CSV: quoted fields, embedded newlines, `;` delimiter, ragged rows, BOM.
- TSV: tab-delimited.
- Markdown: escaped pipes (`\|`), alignment/separator row, leading/trailing pipes, ragged rows.
- Header detection: header present vs absent (synthesized `column_N`), duplicate/blank headers.
- Type inference: integer/number/boolean/null/string, mixed-column ⇒ string.
- Schema: validate + coerce a row; a failing row ⇒ `ok:false` with an actionable error.
- Unparseable input ⇒ `ok:false`.
- `schemaValidate` shared helper: a focused test (and tool #1's tests still pass after the refactor).

## Verification

- `npm run typecheck` + `npm run build` clean; `vitest run` green (tool #1 tests unchanged).
- The existing no-funds self-test confirms `tabular_to_json` is gated + priced through CDP
  (an unpaid `tools/call` → HTTP 402 with `amount` = `$0.03` atomic; an ephemeral signed call →
  CDP funds-only rejection, proving the payment path works for the new tool).
- Deploy as a new image revision; `tools/list` shows both tools.
