# x402-json-repair-mcp

A small, autonomous, **pay-per-call MCP server** that AI agents discover and pay for per call, with revenue landing directly in a USDC wallet on **Base** via the [x402](https://x402.org) payment protocol.

- **One pure-logic tool today:** `structured_json_repair` — deterministic JSON repair + JSON Schema validation/coercion. No model or paid API on the hot path, so each call costs ~nothing to serve (~100% margin).
- **Tool-agnostic core:** the MCP + payment + deploy skeleton is separate from tool logic. Adding tool #2 is a one-file change.
- **Cheap, serverless, near-zero maintenance:** runs on Cloudflare Workers (Node fallback included). Stateless. Holds **no private keys** — only a public payout address.

---

## What it does

`structured_json_repair` takes a messy/invalid JSON-ish string (the kind LLMs and tools frequently emit) plus an optional JSON Schema, and returns clean, valid, schema-conformant JSON — with structured diagnostics when it can't fully fix it.

**Fixes:** trailing commas, single-quoted strings, unquoted keys, Python literals (`None`/`True`/`False`), `NaN`/`Infinity`, Markdown ```` ``` ```` code-fence wrappers, and truncated/garbled tails. With a schema, it validates (JSON Schema draft 2020-12) and optionally coerces primitives (`"36"` → `36`, `"true"` → `true`).

**Input** (`tools/call` arguments):

| field | type | required | default | description |
|-------|------|----------|---------|-------------|
| `input` | string | ✅ | — | The raw/malformed JSON text. |
| `schema` | object | — | — | JSON Schema (draft 2020-12) to validate/coerce against. |
| `coerce` | boolean | — | `true` | Coerce primitive types to satisfy the schema. |

**Output** (`structuredContent`):

```jsonc
{
  "ok": true,                 // valid JSON (and schema-valid when a schema was given)
  "data": { "...": "..." },   // the repaired/validated value; null if unfixable
  "changed": true,            // true if any repair or coercion modified the input
  "errors": [],               // actionable messages when ok is false
  "repairs": ["Removed trailing comma(s) before a closing } or ]."]
}
```

Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

---

## Pricing

| Tool | Price | Network | Asset |
|------|-------|---------|-------|
| `structured_json_repair` | **$0.01 / call** | Base (mainnet) / Base Sepolia (sandbox) | USDC |

Discovery is free: `initialize`, `tools/list`, and `ping` are never charged — only a `tools/call` to a paid tool is.

---

## How it works

```
agent (x402-enabled MCP client)
        │  POST /mcp  (JSON-RPC: tools/call structured_json_repair)
        ▼
┌─────────────────────────── Hono app (Workers / Node) ───────────────────────────┐
│  PaymentGate.evaluate()                                                          │
│   • initialize / tools/list / ping / free tools ─────────────► run MCP, return   │
│   • paid tools/call:                                                             │
│        no/invalid payment ─► HTTP 402 + x402 "payment-required" envelope         │
│        valid payment      ─► run MCP tool ─► settle ─► result + receipt header   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Because every MCP call hits a single `/mcp` endpoint, the gate inspects the JSON-RPC `method`/tool name and maps each paid tool to a **synthetic x402 route** (`POST /x402/<tool>`). The official x402 engine (`@x402/core` + `@x402/evm`) then handles price→atomic conversion, USDC asset resolution, the 402 envelope, facilitator verification, and on-chain settlement. Payment lives entirely at the HTTP layer and is transparent to JSON-RPC.

A real unpaid call returns (verified against the public testnet facilitator):

```
HTTP/1.1 402 Payment Required
payment-required: <base64 x402 v2 envelope>
```
```jsonc
// decoded envelope
{ "x402Version": 2,
  "resource": { "url": ".../x402/structured_json_repair", ... },
  "accepts": [{ "scheme": "exact", "network": "eip155:84532",
                "amount": "10000", "asset": "0x036CbD…CF7e" /* USDC on Base Sepolia */,
                "payTo": "0x…", "maxTimeoutSeconds": 300,
                "extra": { "name": "USDC", "version": "2" } }] }
```

---

## Quick start (local sandbox / testnet)

```bash
npm install
cp .dev.vars.example .dev.vars      # then set PAYOUT_WALLET_ADDRESS (a PUBLIC 0x address)
npm run build
PAYOUT_WALLET_ADDRESS=0xYourPublicAddress npm start   # Node server on :8787
# or: npm run dev        (Cloudflare Workers dev server via wrangler)
```

Exercise it (no payment needed for discovery; the paid call returns 402):

```bash
# tools/list — free
curl -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# paid tool, unpaid — returns HTTP 402 with the x402 envelope in the `payment-required` header
curl -i -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"structured_json_repair","arguments":{"input":"{a:1,}"}}}'
```

Inspect interactively with the MCP Inspector:

```bash
npm run inspector      # then connect to Streamable HTTP at http://localhost:8787/mcp
```

### Sample agent call

An x402-enabled MCP client pays automatically: it calls the tool, receives the 402, signs a USDC payment from its own wallet, and retries with the payment header — all transparently. With the x402 SDK (`@x402/*` + a wallet), wrap the HTTP transport so 402s are auto-paid, then use the standard MCP client against `https://<host>/mcp`. See the x402 client docs: <https://docs.x402.org>.

---

## Project layout

```
src/
  index.ts            # Hono app: routes, x402 gate wiring, Workers entry (default export)
  node.ts             # Node/VPS entry (npm start / bin)
  config.ts           # env loading + validation (address-only; refuses private keys)
  mcp/
    server.ts         # MCP server factory; registers tools (tool-agnostic core)
    transport.ts      # stateless Streamable HTTP via @hono/mcp
  tools/
    structuredJsonRepair.ts   # pure tool logic + Zod input/output schemas + registration
    index.ts          # tool registry — add new tools here
    types.ts          # ToolModule contract
  payments/
    x402.ts           # paywall: per-tool routes, facilitator, verify/settle, JSON-RPC gating
test/
  structuredJsonRepair.test.ts
  paywall.test.ts
server.json           # Official MCP Registry metadata
wrangler.toml         # Cloudflare Workers config (sandbox + production envs)
.dev.vars.example     # example env (placeholders only — no secrets)
```

### Adding a tool (tool-agnostic core)

1. Create `src/tools/myTool.ts` exporting a `ToolModule` (`name`, `title`, `description`, `price`, `register`). Set `price: null` for a free tool or `"$0.05"` for a paid one.
2. Append it to the array in `src/tools/index.ts`. That's the only change — the MCP, payment, and deploy layers pick it up automatically (the gate prices every tool whose `price !== null`).

---

## Configuration

All config comes from environment variables (Workers `[vars]` / `wrangler secret`, or the process env on Node).

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `PAYOUT_WALLET_ADDRESS` | ✅ | — | **Public** USDC payout address (`0x` + 40 hex). Never a private key. |
| `X402_MODE` | — | `sandbox` | `sandbox` (testnet) or `production` (mainnet). |
| `X402_NETWORK` | — | by mode | `eip155:84532` (Base Sepolia) or `eip155:8453` (Base). |
| `X402_FACILITATOR_URL` | — | `https://x402.org/facilitator` | Public facilitator (works for testnet). |
| `X402_USE_CDP_FACILITATOR` | — | `false` | `true` for the Coinbase CDP facilitator (mainnet). |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | prod only | — | CDP facilitator credentials (set as secrets). |
| `PRICE_STRUCTURED_JSON_REPAIR` | — | `$0.01` | Per-tool price override (USD). |

---

## Deploy

See **[OPERATOR_CHECKLIST.md](./OPERATOR_CHECKLIST.md)** for the exact human-only steps (wallet, accounts, secrets, deploy, publish). In short:

```bash
# Sandbox (Base Sepolia, public facilitator)
wrangler secret put PAYOUT_WALLET_ADDRESS
wrangler deploy                       # → https://x402-json-repair-mcp.<subdomain>.workers.dev/mcp

# Production (Base mainnet, Coinbase CDP facilitator)
wrangler secret put PAYOUT_WALLET_ADDRESS --env production
wrangler secret put CDP_API_KEY_ID --env production
wrangler secret put CDP_API_KEY_SECRET --env production
wrangler deploy --env production
```

**Node / VPS fallback:** `npm run build && PAYOUT_WALLET_ADDRESS=0x… npm start` (serves `/mcp` on `:8787`; put it behind TLS).

## Listing & discovery

- **Official MCP Registry:** edit `server.json` (set your `OWNER` namespace and the deployed URL), then publish with the registry `mcp-publisher` CLI. The registry feeds Smithery, PulseMCP, etc.
- **x402 Bazaar / Agentic.market:** the server serves machine-readable discovery at `GET /.well-known/x402` (capability + pricing per tool). Submit per current x402 docs.
- **npm:** `npm publish` (the package is runnable via `npx x402-json-repair-mcp` for self-hosting).

Operator-run commands are in **[OPERATOR_CHECKLIST.md](./OPERATOR_CHECKLIST.md)**.

---

## Security

- **Address only — never a private key.** The server reads `PAYOUT_WALLET_ADDRESS` to tell payers where to send USDC; it never signs or moves funds. `config.ts` actively **refuses** anything shaped like a private key (64 hex) or seed phrase.
- **No secrets in source.** Use `.dev.vars` locally (gitignored) and `wrangler secret` in production. Only `.dev.vars.example` (placeholders) is committed.
- **Stateless.** Request payloads aren't persisted beyond serving the response.

## Engineering notes

- **x402 v2.** Uses the maintained `@x402/core` / `@x402/evm` packages (the v1 `x402`/`x402-hono` packages are deprecated). The 402 envelope is delivered in the `payment-required` response header (v2), which the agent's x402 client reads and pays.
- **Validation uses `@cfworker/json-schema`, not Ajv.** Ajv compiles validators at runtime via the `Function` constructor, which Cloudflare Workers forbid (no `eval`). Since the schema is a *runtime* input, it can't be precompiled — so we use the eval-free, Workers-native `@cfworker/json-schema` (already an MCP SDK peer) plus a small schema-driven coercion pass.

## Roadmap

- **Phase 2 — vertical document parser (planned, not built):** a tool for one document type that general parsers handle poorly (e.g. a specific statement/invoice/receipt format), priced toward the work-done end ($0.05–$0.10/call). It would slot in as another `ToolModule` with no changes to the MCP/payment/deploy core.

## License

MIT
