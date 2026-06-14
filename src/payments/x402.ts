import { Context } from "hono";
import {
  x402ResourceServer,
  x402HTTPResourceServer,
  HTTPFacilitatorClient,
} from "@x402/core/server";
import type {
  HTTPAdapter,
  HTTPRequestContext,
  HTTPProcessResult,
  HTTPResponseInstructions,
  ProcessSettleResultResponse,
  RouteConfig,
  RoutesConfig,
  FacilitatorConfig,
} from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import type { AppConfig } from "../config.js";
import type { PaidToolSpec } from "../tools/index.js";

/**
 * The subset of x402HTTPResourceServer we depend on. Declaring it as an interface
 * lets unit tests inject a fake processor with no network or facilitator.
 */
export interface X402Processor {
  initialize(): Promise<void>;
  processHTTPRequest(context: HTTPRequestContext): Promise<HTTPProcessResult>;
  processSettlement(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
  ): Promise<ProcessSettleResultResponse>;
}

/** Each paid MCP tool is mapped to a synthetic HTTP route so the x402 engine can price it. */
export function syntheticPathFor(toolName: string): string {
  return `/x402/${toolName}`;
}

export type Classification =
  | { kind: "free" }
  | { kind: "paid"; toolName: string }
  | { kind: "batched-paid" };

function paidToolCallName(message: unknown, isPaid: (name: string) => boolean): string | null {
  if (!message || typeof message !== "object") return null;
  const m = message as { method?: unknown; params?: unknown };
  if (m.method !== "tools/call") return null;
  const params = m.params as { name?: unknown } | undefined;
  if (!params || typeof params.name !== "string") return null;
  return isPaid(params.name) ? params.name : null;
}

/** Decide whether a JSON-RPC request body requires payment (and for which tool). */
export function classifyRequest(body: unknown, isPaid: (name: string) => boolean): Classification {
  if (Array.isArray(body)) {
    return body.some((m) => paidToolCallName(m, isPaid) !== null)
      ? { kind: "batched-paid" }
      : { kind: "free" };
  }
  const toolName = paidToolCallName(body, isPaid);
  return toolName ? { kind: "paid", toolName } : { kind: "free" };
}

/** Build x402 route config (one synthetic route per paid tool). */
export function buildToolRoutes(
  paidTools: PaidToolSpec[],
  opts: { payTo: string; network: Network; prices: Record<string, string> },
): RoutesConfig {
  const routes: Record<string, RouteConfig> = {};
  for (const tool of paidTools) {
    routes[`POST ${syntheticPathFor(tool.name)}`] = {
      accepts: {
        scheme: "exact",
        payTo: opts.payTo,
        price: opts.prices[tool.name] ?? tool.defaultPrice,
        network: opts.network,
      },
      description: tool.description,
      mimeType: "application/json",
      serviceName: tool.title,
    };
  }
  return routes;
}

/** Hono-backed HTTP adapter. Headers come from the real request; path/url are synthetic per tool. */
export class HonoHTTPAdapter implements HTTPAdapter {
  constructor(
    private readonly c: Context,
    private readonly path: string,
    private readonly url: string,
  ) {}
  getHeader(name: string): string | undefined {
    return this.c.req.header(name);
  }
  getMethod(): string {
    return "POST";
  }
  getPath(): string {
    return this.path;
  }
  getUrl(): string {
    return this.url;
  }
  // Force the JSON (API) 402 path; never the browser HTML paywall — callers are agents.
  getAcceptHeader(): string {
    return "application/json";
  }
  getUserAgent(): string {
    return this.c.req.header("user-agent") ?? "x402-mcp-client";
  }
}

function instructionsToResponse(instr: HTTPResponseInstructions): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(instr.headers ?? {})) headers.set(k, v);
  let body: string | null = null;
  if (instr.body !== undefined && instr.body !== null) {
    if (typeof instr.body === "string") {
      body = instr.body;
    } else {
      body = JSON.stringify(instr.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }
  return new Response(body, { status: instr.status, headers });
}

function mergeHeaders(response: Response, extra: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function resourceUrl(c: Context, path: string): string {
  try {
    return new URL(c.req.url).origin + path;
  } catch {
    return path;
  }
}

function requestId(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return (body as { id?: unknown }).id ?? null;
  }
  return null;
}

/**
 * x402 payment gate for MCP. Free JSON-RPC methods (initialize, tools/list, ping, notifications)
 * and free tools pass straight through. A paid `tools/call` is verified before the tool runs and
 * settled after, with the on-chain receipt attached to the response.
 */
export class PaymentGate {
  private initPromise?: Promise<void>;

  constructor(
    private readonly processor: X402Processor,
    private readonly paidNames: Set<string>,
  ) {}

  readonly isPaid = (name: string): boolean => this.paidNames.has(name);

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.processor.initialize().catch((e) => {
        this.initPromise = undefined;
        throw e;
      });
    }
    return this.initPromise;
  }

  async evaluate(c: Context, body: unknown, runMcp: () => Promise<Response>): Promise<Response> {
    const classification = classifyRequest(body, this.isPaid);

    if (classification.kind === "free") {
      return runMcp();
    }
    if (classification.kind === "batched-paid") {
      return jsonResponse(400, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message:
            "x402-gated tools must be called in a single (non-batched) JSON-RPC request so payment can be matched per call.",
        },
      });
    }

    try {
      await this.ensureInitialized();
    } catch (e) {
      return jsonResponse(503, {
        jsonrpc: "2.0",
        id: requestId(body),
        error: {
          code: -32000,
          message: `Payment facilitator unavailable; cannot verify payment right now: ${e instanceof Error ? e.message : String(e)}`,
        },
      });
    }

    const path = syntheticPathFor(classification.toolName);
    const adapter = new HonoHTTPAdapter(c, path, resourceUrl(c, path));
    const context: HTTPRequestContext = {
      adapter,
      path,
      method: "POST",
      paymentHeader: adapter.getHeader("x-payment"),
    };

    const result = await this.processor.processHTTPRequest(context);

    if (result.type === "payment-error") {
      return instructionsToResponse(result.response);
    }
    if (result.type === "no-payment-required") {
      return runMcp();
    }

    // payment-verified: run the tool, then settle. If runMcp throws we never settle → no charge.
    const mcpResponse = await runMcp();
    const settlement = await this.processor.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions,
    );
    if (settlement.success) {
      return mergeHeaders(mcpResponse, settlement.headers);
    }
    return instructionsToResponse(settlement.response);
  }
}

/**
 * Normalize a CDP API private key for the Coinbase SDK.
 * The SDK validates EC keys with jose `importPKCS8`, which only accepts PKCS#8
 * (`-----BEGIN PRIVATE KEY-----`). CDP issues SEC1 (`-----BEGIN EC PRIVATE KEY-----`),
 * so we convert it. Also tolerates `\n`-escaped keys (common when pasted into env).
 */
async function normalizeCdpPrivateKey(secret: string): Promise<string> {
  let pem = secret.includes("\\n") ? secret.replace(/\\n/g, "\n") : secret;
  if (pem.includes("BEGIN EC PRIVATE KEY")) {
    try {
      const { createPrivateKey } = await import("node:crypto");
      pem = createPrivateKey({ key: pem, format: "pem" })
        .export({ format: "pem", type: "pkcs8" })
        .toString();
    } catch {
      // Leave as-is; the SDK will surface a clear error if it's truly invalid.
    }
  }
  return pem;
}

async function resolveFacilitatorConfig(config: AppConfig): Promise<FacilitatorConfig> {
  if (config.useCdp) {
    const cdp = await import("@coinbase/x402");
    const secret = config.cdpApiKeySecret
      ? await normalizeCdpPrivateKey(config.cdpApiKeySecret)
      : config.cdpApiKeySecret;
    return cdp.createFacilitatorConfig(config.cdpApiKeyId, secret);
  }
  return { url: config.facilitatorUrl };
}

/** Build the real x402 HTTP resource server (route-per-tool) backed by a facilitator. */
export async function buildX402Processor(
  config: AppConfig,
  paidTools: PaidToolSpec[],
): Promise<x402HTTPResourceServer> {
  const facilitatorConfig = await resolveFacilitatorConfig(config);
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient(facilitatorConfig));
  registerExactEvmScheme(resourceServer);
  const routes = buildToolRoutes(paidTools, {
    payTo: config.payTo,
    network: config.network,
    prices: config.prices,
  });
  return new x402HTTPResourceServer(resourceServer, routes);
}

export async function buildPaymentGate(
  config: AppConfig,
  paidTools: PaidToolSpec[],
): Promise<PaymentGate> {
  const processor = await buildX402Processor(config, paidTools);
  return new PaymentGate(processor, new Set(paidTools.map((t) => t.name)));
}
