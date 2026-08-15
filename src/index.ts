import { Hono } from "hono";
import type { Context } from "hono";
import { handleMcpRequest } from "./mcp/transport.js";
import { SERVER_NAME, SERVER_VERSION, SERVICE_TITLE } from "./mcp/server.js";

/**
 * One-paragraph service pitch, reused by the manifest and the x402 discovery document.
 * Kept under the Bazaar's 500-char description limit and front-loaded with the data domains
 * agents actually search for — catalog ranking weighs description completeness.
 */
const SERVICE_DESCRIPTION =
  "Pay-per-call data tools for AI agents, settled in USDC on Base via x402. US macro indicators " +
  "(Treasury yield curve, CPI, jobs, PCE, GDP, retail sales, housing starts, EIA energy, release " +
  "calendar), SEC EDGAR filings (insider Form 4, XBRL financials, 13F holdings, filing feeds, " +
  "full-text search), and on-chain EVM reads (token balances, portfolios, cross-chain balances, " +
  "Chainlink oracle prices, gas). Plus deterministic JSON repair and tabular-to-JSON parsing.";
import { paidToolSpecs, tools } from "./tools/index.js";
import {
  loadConfig,
  priceEnvVar,
  type AppConfig,
  type Env,
  type ToolPriceSpec,
} from "./config.js";
import { buildPaymentGate, classifyRequest, type PaymentGate } from "./payments/x402.js";
import { buildSnapshot, renderMonitorHtml } from "./monitor.js";
import { SKILL_MD, VERIFICATION_MD, CONFORMANCE_MD } from "./docs.generated.js";

const PAID_SPECS = paidToolSpecs();
const PRICE_SPECS: ToolPriceSpec[] = PAID_SPECS.map((s) => ({
  name: s.name,
  defaultPrice: s.defaultPrice,
}));
const PAID_BY_NAME = new Map(PAID_SPECS.map((s) => [s.name, s]));
/** Which tools cost money — static, so free methods can be answered without loading config. */
const isPaidTool = (name: string): boolean => PAID_BY_NAME.has(name);

// One gate per distinct config (a Worker isolate / Node process serves one deployment).
let gateCache: { sig: string; gate: Promise<PaymentGate> } | undefined;

function readEnv(c: Context): Env {
  // Node: env lives in process.env (c.env holds { incoming, outgoing }).
  // Workers: env vars/secrets arrive as string values on c.env.
  // Merge both, keeping only string bindings (skips Node's req/res objects).
  const out: Env = {};
  if (typeof process !== "undefined" && process.env) {
    Object.assign(out, process.env);
  }
  const bindings = c.env as Record<string, unknown> | undefined;
  if (bindings) {
    for (const [k, v] of Object.entries(bindings)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

function configSignature(config: AppConfig): string {
  return [
    config.payTo,
    config.network,
    config.mode,
    config.facilitatorUrl,
    String(config.useCdp),
    JSON.stringify(config.prices),
  ].join("|");
}

function getGate(config: AppConfig): Promise<PaymentGate> {
  const sig = configSignature(config);
  if (!gateCache || gateCache.sig !== sig) {
    gateCache = { sig, gate: buildPaymentGate(config, PAID_SPECS) };
  }
  return gateCache.gate;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** JSON response with an arbitrary numeric status (Hono's c.json narrows the status type). */
function jsonBody(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Unwrap a JSON-RPC `tools/call` response into the tool's plain JSON result.
 *
 * Headers are carried over so the x402 `payment-response` receipt survives; content-length is
 * dropped because the body is rewritten. Anything that isn't a 200 with a JSON-RPC `result`
 * (a 402, an error envelope) passes through untouched.
 */
async function unwrapRpcResult(res: Response): Promise<Response> {
  if (res.status !== 200) return res;

  let text: string;
  try {
    text = await res.clone().text();
  } catch {
    return res;
  }

  let parsed: { result?: { structuredContent?: unknown } } | undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The transport may emit SSE frames instead of a single JSON document.
    const frame = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("data:"));
    if (!frame) return res;
    try {
      parsed = JSON.parse(frame.slice(5).trim());
    } catch {
      return res;
    }
  }

  const result = parsed?.result;
  if (result === undefined || result === null) return res;

  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(result.structuredContent ?? result), { status: 200, headers });
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function requestId(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return (body as { id?: unknown }).id ?? null;
  }
  return null;
}

function normalizePriceDisplay(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("$") ? trimmed : `$${trimmed}`;
}

function envMode(env: Env): "sandbox" | "production" {
  return (env.X402_MODE ?? "sandbox").trim().toLowerCase() === "production" ? "production" : "sandbox";
}

function envNetwork(env: Env): string {
  const mode = envMode(env);
  return env.X402_NETWORK?.trim() || (mode === "production" ? "eip155:8453" : "eip155:84532");
}

function envPayTo(env: Env): string | null {
  const value = (env.PAYOUT_WALLET_ADDRESS ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value : null;
}

function origin(c: Context): string {
  try {
    return new URL(c.req.url).origin;
  } catch {
    return "";
  }
}

/** Human/agent-readable service manifest (free, no payment). */
function buildManifest(env: Env, c: Context) {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: SERVICE_DESCRIPTION,
    mcpEndpoint: `${origin(c)}/mcp`,
    transport: "streamable-http (stateless JSON)",
    payment: {
      protocol: "x402",
      asset: "USDC",
      network: envNetwork(env),
      payTo: envPayTo(env),
      mode: envMode(env),
    },
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      price: t.price ? normalizePriceDisplay(env[priceEnvVar(t.name)] ?? t.price) : null,
      description: t.description,
    })),
    discovery: `${origin(c)}/.well-known/x402`,
  };
}

/** x402 Bazaar-style discovery document (machine-readable capability + pricing). */
function buildDiscovery(env: Env, c: Context) {
  const network = envNetwork(env);
  const payTo = envPayTo(env);
  const base = origin(c);
  return {
    x402Version: 1,
    service: {
      name: SERVER_NAME,
      title: SERVICE_TITLE,
      version: SERVER_VERSION,
      description: SERVICE_DESCRIPTION,
      mcpEndpoint: `${base}/mcp`,
    },
    resources: PAID_SPECS.map((s) => ({
      resource: `${base}/x402/${s.name}`,
      mcpTool: s.name,
      title: s.title,
      description: s.description,
      accepts: payTo
        ? [
            {
              scheme: "exact",
              network,
              asset: "USDC",
              price: normalizePriceDisplay(env[priceEnvVar(s.name)] ?? s.defaultPrice),
              payTo,
            },
          ]
        : [],
    })),
  };
}

/**
 * OpenAPI 3.1 description of the per-tool x402 routes.
 *
 * This is the discovery contract third-party indexers (x402scan / Poncho) fetch from
 * `/openapi.json`; they reject an origin outright with "No discovery document found" without it.
 * Payable operations must carry `x-payment-info` and declare a 402 response.
 *
 * Note the units mismatch, which is intentional and required: `x-payment-info.price.amount` is
 * DECIMAL USD ("0.005"), while the runtime x402 `accepts[].amount` is atomic token units
 * ("5000" for USDC's 6 decimals). Both describe the same price.
 */
function buildOpenApi(env: Env, c: Context) {
  const base = origin(c);
  const paths: Record<string, unknown> = {};

  for (const spec of PAID_SPECS) {
    const usd = normalizePriceDisplay(env[priceEnvVar(spec.name)] ?? spec.defaultPrice).replace(
      /^\$/,
      "",
    );
    paths[`/x402/${spec.name}`] = {
      post: {
        operationId: spec.name,
        summary: spec.title,
        description: spec.description,
        "x-payment-info": {
          price: { mode: "fixed", currency: "USD", amount: usd },
          protocols: [{ x402: {} }],
        },
        requestBody: {
          required: Boolean(
            (spec.discovery?.inputSchema as { required?: unknown[] } | undefined)?.required?.length,
          ),
          content: {
            "application/json": {
              schema: spec.discovery?.inputSchema ?? { type: "object" },
              ...(spec.discovery?.inputExample ? { example: spec.discovery.inputExample } : {}),
            },
          },
        },
        responses: {
          "200": {
            description: "Tool result as JSON.",
            content: {
              "application/json": {
                schema: spec.discovery?.output?.schema ?? { type: "object" },
                ...(spec.discovery?.output?.example
                  ? { example: spec.discovery.output.example }
                  : {}),
              },
            },
          },
          "402": { description: "Payment Required" },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE_TITLE,
      version: SERVER_VERSION,
      description: SERVICE_DESCRIPTION,
      contact: { email: "info@agentfund.net" },
      "x-guidance":
        "Each route is one tool, priced per call and settled in USDC on Base via x402. " +
        "POST the tool's arguments as a plain JSON body; the response is the tool's result as " +
        "JSON. An unpaid request returns 402 with the payment requirements in the " +
        "`payment-required` header. Data comes from free public sources (US Treasury, BLS, BEA, " +
        "Census, EIA, SEC EDGAR, and public EVM RPC), so figures carry each source's own " +
        "publication lag and revision policy. The same tools are also callable over MCP at /mcp.",
    },
    servers: [{ url: base }],
    paths,
  };
}

export const app = new Hono();

app.get("/", (c) => c.json(buildManifest(readEnv(c), c)));

app.get("/health", (c) => {
  try {
    const config = loadConfig(readEnv(c), PRICE_SPECS);
    return c.json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      mode: config.mode,
      network: config.network,
      mcpEndpoint: "/mcp",
    });
  } catch (e) {
    return c.json({ status: "misconfigured", server: SERVER_NAME, error: errMessage(e) }, 500);
  }
});

app.get("/.well-known/x402", (c) => c.json(buildDiscovery(readEnv(c), c)));

// Discovery contract for third-party indexers; see buildOpenApi.
app.get("/openapi.json", (c) => c.json(buildOpenApi(readEnv(c), c)));

/**
 * 32x32 PNG-in-ICO: dark background, rising green bar chart.
 *
 * Directories (x402scan/Poncho, and the Bazaar's `iconUrl`) show an icon for origins that serve
 * one, and most listings don't bother — it is cheap differentiation in a crowded catalog. The
 * asset is 154 bytes, so inlining beats an asset binding or an external fetch.
 */
const FAVICON_ICO_BASE64 =
  "AAABAAEAICAAAAEAIACEAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAAEtJ" +
  "REFUeNpj4BZS+D+QmGHUAaMOGHXAsHSA0tE4DDzqgFEHUN0B+CwZdcCoA6jmAHItGXXAqANGHUCxA9xD" +
  "M2mGR9uEow4YdQA6BgC6ObvkiLD89wAAAABJRU5ErkJggg==";

/**
 * Agent-facing usage guide and the data-correctness ledger, served as plain Markdown.
 *
 * SKILL.md is the target of the Bazaar's `skillUrl` field — unused by essentially every listing
 * in the catalog, so it is cheap differentiation. VERIFICATION.md records upstream traps found by
 * checking each tool against live data, including one where the publisher's own documentation is
 * wrong; it is the substantive trust signal, so it must stay reachable at a stable URL.
 */
const markdown = (body: string, maxAge = 3600) =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });

app.get("/SKILL.md", () => markdown(SKILL_MD));
app.get("/VERIFICATION.md", () => markdown(VERIFICATION_MD));
// Dated results from real paid runs of the conformance suite. Published because a correctness
// claim nobody can inspect is only an assertion. Cached briefly, not for an hour like the static
// docs: the entire value of this page is that it reflects the most recent run.
app.get("/CONFORMANCE.md", () => markdown(CONFORMANCE_MD, 300));

/**
 * Live settlement monitor for the payout wallet. Free and unauthenticated: it exposes only the
 * payout address and its on-chain USDC transfers, all of which are already public on Base.
 */
app.get("/monitor.json", async (c) => {
  const payTo = envPayTo(readEnv(c));
  if (!payTo) return jsonBody(500, { error: "PAYOUT_WALLET_ADDRESS is not configured." });
  return c.json(await buildSnapshot(payTo, PAID_SPECS));
});

app.get("/monitor", async (c) => {
  const payTo = envPayTo(readEnv(c));
  if (!payTo) return jsonBody(500, { error: "PAYOUT_WALLET_ADDRESS is not configured." });
  const snapshot = await buildSnapshot(payTo, PAID_SPECS);
  return c.html(renderMonitorHtml(snapshot, tools.length));
});

app.get("/favicon.ico", (c) => {
  const bytes = Uint8Array.from(atob(FAVICON_ICO_BASE64), (ch) => ch.charCodeAt(0));
  return c.body(bytes, 200, {
    "content-type": "image/x-icon",
    "cache-control": "public, max-age=86400",
  });
});

/**
 * Per-tool x402 HTTP routes: `POST|GET /x402/<tool>`.
 *
 * These exist for DISCOVERY, not convenience. The x402 Bazaar indexes plain HTTP resources
 * only — every one of its ~15k catalog entries is `type: "http"`, and `?type=mcp` returns
 * zero — so an MCP endpoint alone can never be listed. Each paid tool therefore needs its own
 * addressable URL that answers 402 to an unauthenticated probe, matching the shape the
 * Bazaar validator checks. Callers who already speak MCP should keep using `/mcp`.
 *
 * Body (POST) is the tool's arguments object directly, not a JSON-RPC envelope. A successful
 * call returns the tool's `structuredContent` as plain JSON, with the x402 settlement receipt
 * in the `payment-response` header.
 */
app.on(["GET", "POST"], "/x402/:tool", async (c) => {
  const toolName = c.req.param("tool");
  const spec = PAID_BY_NAME.get(toolName);
  if (!spec) {
    return jsonBody(404, {
      error: `Unknown paid tool '${toolName}'.`,
      availableTools: [...PAID_BY_NAME.keys()],
    });
  }

  // Arguments come from the POST body. Tools that take no arguments are called with {}.
  let args: Record<string, unknown> = {};
  if (c.req.method === "POST") {
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        args = raw as Record<string, unknown>;
      }
    } catch {
      // Absent or malformed body → empty arguments; the tool's own schema reports what's missing.
    }
  }

  let config: AppConfig;
  try {
    config = loadConfig(readEnv(c), PRICE_SPECS);
  } catch (e) {
    return jsonBody(500, { error: `Server misconfigured: ${errMessage(e)}` });
  }

  let gate: PaymentGate;
  try {
    gate = await getGate(config);
  } catch (e) {
    return jsonBody(503, { error: `Payment layer unavailable: ${errMessage(e)}` });
  }

  const rpcBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  // Run through the same gate as /mcp so the money-safety rules are identical: a tool that
  // throws yields isError:true and is returned UNSETTLED rather than billed.
  const gated = await gate.chargeAndRun(
    c,
    toolName,
    () => handleMcpRequest(c, rpcBody),
    (status, message) => jsonBody(status, { error: message }),
    // Advertise the http/body discovery shape: the mcp variant is never indexed by the Bazaar.
    "http",
  );
  return unwrapRpcResult(gated);
});

app.post("/mcp", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "Parse error: request body is not valid JSON."), 400);
  }

  // Discovery must not depend on payment configuration. `initialize`, `tools/list` and `ping`
  // take no money, so requiring PAYOUT_WALLET_ADDRESS to answer them would make the server
  // un-introspectable wherever payment isn't configured — a fresh clone, a CI sandbox, or a
  // directory's automated check. Only a paid tools/call needs the gate.
  if (classifyRequest(body, isPaidTool).kind === "free") {
    return handleMcpRequest(c, body);
  }

  let config: AppConfig;
  try {
    config = loadConfig(readEnv(c), PRICE_SPECS);
  } catch (e) {
    return c.json(rpcError(requestId(body), -32000, `Server misconfigured: ${errMessage(e)}`), 500);
  }

  let gate: PaymentGate;
  try {
    gate = await getGate(config);
  } catch (e) {
    return c.json(rpcError(requestId(body), -32000, `Payment layer unavailable: ${errMessage(e)}`), 503);
  }

  return gate.evaluate(c, body, () => handleMcpRequest(c, body));
});

// Stateless server: only POST is supported on /mcp.
app.on(["GET", "DELETE"], "/mcp", (c) =>
  c.json(
    rpcError(null, -32000, "This MCP server is stateless; send a JSON-RPC request via HTTP POST to /mcp."),
    405,
  ),
);

export default app;
