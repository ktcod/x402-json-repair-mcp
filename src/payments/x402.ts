import type { Context } from "hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { FacilitatorConfig } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  PaymentRequired,
  ResourceInfo,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import type { AppConfig } from "../config.js";
import type { PaidToolSpec } from "../tools/index.js";

/** Each paid MCP tool is exposed at a synthetic resource path for the 402 `resource` URL. */
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

/**
 * Minimal surface of x402ResourceServer the gate needs. We use the resource server DIRECTLY
 * (decode the payment header → verify → settle) rather than the route-wrapper's HTTP handling,
 * because the wrapper forwards a payment that the strict Coinbase CDP facilitator rejects.
 * Declaring it as an interface also lets unit tests inject a fake with no network.
 */
export interface ResourceServerLike {
  initialize(): Promise<void>;
  buildPaymentRequirementsFromOptions(
    options: Array<{
      scheme: string;
      payTo: string;
      price: string;
      network: Network;
      maxTimeoutSeconds?: number;
      extra?: Record<string, unknown>;
    }>,
    context: unknown,
  ): Promise<PaymentRequirements[]>;
  createPaymentRequiredResponse(
    requirements: PaymentRequirements[],
    resourceInfo: ResourceInfo,
    error?: string,
  ): Promise<PaymentRequired>;
  verifyPayment(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settlePayment(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestId(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return (body as { id?: unknown }).id ?? null;
  }
  return null;
}

function resourceUrl(c: Context, path: string): string {
  try {
    return new URL(c.req.url).origin + path;
  } catch {
    return path;
  }
}

/**
 * x402 payment gate for MCP. Free JSON-RPC methods (initialize, tools/list, ping, notifications)
 * and free tools pass straight through. A paid `tools/call` is verified before the tool runs and
 * settled after, with the on-chain receipt attached to the response.
 */
export class PaymentGate {
  private initPromise?: Promise<void>;

  constructor(
    private readonly server: ResourceServerLike,
    private readonly paidNames: Set<string>,
    private readonly opts: {
      payTo: string;
      network: Network;
      prices: Record<string, string>;
      specs: Map<string, PaidToolSpec>;
    },
  ) {}

  readonly isPaid = (name: string): boolean => this.paidNames.has(name);

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.server.initialize().catch((e) => {
        this.initPromise = undefined;
        throw e;
      });
    }
    return this.initPromise;
  }

  private async build402(
    requirements: PaymentRequirements[],
    resourceInfo: ResourceInfo,
    error: string,
  ): Promise<Response> {
    const paymentRequired = await this.server.createPaymentRequiredResponse(
      requirements,
      resourceInfo,
      error,
    );
    return new Response("{}", {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": encodePaymentRequiredHeader(paymentRequired),
        "access-control-expose-headers": "payment-required",
      },
    });
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

    const { toolName } = classification;
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

    const spec = this.opts.specs.get(toolName);
    const price = this.opts.prices[toolName] ?? spec?.defaultPrice ?? "$0.01";
    const path = syntheticPathFor(toolName);
    // Keep the x402 `resource` lightweight: a short, ASCII, single-line description.
    // The full tool docs live in the MCP tools/list listing (the discovery surface).
    // The Coinbase CDP facilitator rejects payment payloads whose echoed
    // resource.description is long / multi-line / non-ASCII.
    const resourceInfo: ResourceInfo = {
      url: resourceUrl(c, path),
      description: spec?.title ?? toolName,
      mimeType: "application/json",
      serviceName: spec?.title,
    };

    let requirements: PaymentRequirements[];
    try {
      requirements = await this.server.buildPaymentRequirementsFromOptions(
        [{ scheme: "exact", payTo: this.opts.payTo, price, network: this.opts.network }],
        {},
      );
    } catch (e) {
      return jsonResponse(500, {
        jsonrpc: "2.0",
        id: requestId(body),
        error: {
          code: -32000,
          message: `Could not build payment requirements: ${e instanceof Error ? e.message : String(e)}`,
        },
      });
    }
    if (requirements.length === 0) {
      return jsonResponse(500, {
        jsonrpc: "2.0",
        id: requestId(body),
        error: { code: -32000, message: "No payment requirements available for this tool." },
      });
    }
    const requirement = requirements[0];

    const sigHeader = c.req.header("payment-signature") ?? c.req.header("x-payment");
    if (!sigHeader) {
      return this.build402(requirements, resourceInfo, "Payment required");
    }

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(sigHeader);
    } catch {
      return this.build402(requirements, resourceInfo, "Malformed payment header");
    }

    let verify: VerifyResponse;
    try {
      verify = await this.server.verifyPayment(payload, requirement);
    } catch (e) {
      return this.build402(
        requirements,
        resourceInfo,
        `Payment verification error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!verify.isValid) {
      return this.build402(
        requirements,
        resourceInfo,
        verify.invalidReason ?? verify.invalidMessage ?? "Payment verification failed",
      );
    }

    // Verified → run the tool, then settle. If runMcp throws we never settle → no charge.
    const mcpResponse = await runMcp();
    let settle: SettleResponse;
    try {
      settle = await this.server.settlePayment(payload, requirement);
    } catch (e) {
      return this.build402(
        requirements,
        resourceInfo,
        `Settlement error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!settle.success) {
      return this.build402(requirements, resourceInfo, settle.errorReason ?? "Settlement failed");
    }

    const headers = new Headers(mcpResponse.headers);
    headers.set("payment-response", encodePaymentResponseHeader(settle));
    headers.append("access-control-expose-headers", "payment-response");
    return new Response(mcpResponse.body, {
      status: mcpResponse.status,
      statusText: mcpResponse.statusText,
      headers,
    });
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

/** Build the core x402 resource server (exact EVM scheme) backed by a facilitator. */
export async function buildResourceServer(config: AppConfig): Promise<x402ResourceServer> {
  const facilitatorConfig = await resolveFacilitatorConfig(config);
  const server = new x402ResourceServer(new HTTPFacilitatorClient(facilitatorConfig));
  registerExactEvmScheme(server);
  return server;
}

export async function buildPaymentGate(
  config: AppConfig,
  paidTools: PaidToolSpec[],
): Promise<PaymentGate> {
  const server = await buildResourceServer(config);
  const specs = new Map(paidTools.map((t) => [t.name, t]));
  return new PaymentGate(server, new Set(paidTools.map((t) => t.name)), {
    payTo: config.payTo,
    network: config.network,
    prices: config.prices,
    specs,
  });
}
