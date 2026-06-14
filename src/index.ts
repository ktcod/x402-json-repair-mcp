import { Hono } from "hono";
import type { Context } from "hono";
import { handleMcpRequest } from "./mcp/transport.js";
import { SERVER_NAME, SERVER_VERSION } from "./mcp/server.js";
import { paidToolSpecs, tools } from "./tools/index.js";
import {
  loadConfig,
  priceEnvVar,
  type AppConfig,
  type Env,
  type ToolPriceSpec,
} from "./config.js";
import { buildPaymentGate, type PaymentGate } from "./payments/x402.js";

const PAID_SPECS = paidToolSpecs();
const PRICE_SPECS: ToolPriceSpec[] = PAID_SPECS.map((s) => ({
  name: s.name,
  defaultPrice: s.defaultPrice,
}));

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
    description:
      "Pay-per-call MCP server for deterministic JSON repair + JSON Schema validation, settled in USDC on Base via x402.",
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
      version: SERVER_VERSION,
      description:
        "Deterministic JSON repair + JSON Schema validation as a pay-per-call MCP tool (USDC on Base).",
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

app.post("/mcp", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "Parse error: request body is not valid JSON."), 400);
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
