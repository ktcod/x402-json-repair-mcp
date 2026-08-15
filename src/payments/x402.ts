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
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import type { AppConfig } from "../config.js";
import type { PaidToolSpec } from "../tools/index.js";
import { SERVICE_TITLE } from "../mcp/server.js";

/** Each paid MCP tool is exposed at a synthetic resource path for the 402 `resource` URL. */
export function syntheticPathFor(toolName: string): string {
  return `/x402/${toolName}`;
}

/**
 * Which Bazaar discovery shape to advertise. `http` (body variant) is the only one CDP will
 * live-probe and index; `mcp` is correct for the MCP endpoint but is never catalogued.
 */
export type DiscoveryVariant = "mcp" | "http";

/**
 * Stamp `info.input.method` onto a freshly-declared HTTP discovery extension.
 *
 * `declareDiscoveryExtension` deliberately omits `method` from its input type: it expects
 * `bazaarResourceServerExtension.enrichDeclaration` to fill it in, which only happens inside the
 * x402 route wrapper. This server drives the resource server directly (see ResourceServerLike),
 * so nothing enriches the declaration and CDP rejects it with
 * "input.method must be one of ...". Mutation is safe — the object is created per call.
 */
function withDeclaredMethod(
  extension: Record<string, unknown>,
  method: "POST",
): Record<string, unknown> {
  const bazaar = extension.bazaar as { info?: { input?: Record<string, unknown> } } | undefined;
  if (bazaar?.info?.input) bazaar.info.input.method = method;
  return extension;
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
    extensions?: Record<string, unknown>,
  ): Promise<PaymentRequired>;
  verifyPayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
  ): Promise<VerifyResponse>;
  settlePayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
  ): Promise<SettleResponse>;
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
 * True when an MCP tool-call response reports a failure, so payment must NOT be settled.
 *
 * Detects both a JSON-RPC `error` and a tool result with `isError: true`, over either the
 * `application/json` or `text/event-stream` (SSE) transport. Inspects a CLONE so the original
 * body is left intact for the caller. If the body cannot be inspected we return false and let
 * normal settlement proceed, rather than silently giving work away.
 */
export async function isErroredToolResult(res: Response): Promise<boolean> {
  if (!res.body) return false;
  let text: string;
  try {
    text = await res.clone().text();
  } catch {
    return false;
  }
  if (!text) return false;

  // SSE frames arrive as one or more `data: {...}` lines; plain JSON is a single document.
  const frames = text.includes("data:")
    ? text
        .split(/\r?\n/)
        .filter((l) => l.trim().startsWith("data:"))
        .map((l) => l.trim().slice(5).trim())
    : [text];

  for (const frame of frames) {
    try {
      const parsed = JSON.parse(frame) as {
        error?: unknown;
        result?: { isError?: unknown };
      };
      if (parsed.error !== undefined && parsed.error !== null) return true;
      if (parsed.result?.isError === true) return true;
    } catch {
      // Not parseable as JSON: fall back to a conservative textual check.
      if (/"isError"\s*:\s*true/.test(frame)) return true;
    }
  }
  return false;
}

/**
 * x402 payment gate for MCP. Free JSON-RPC methods (initialize, tools/list, ping, notifications)
 * and free tools pass straight through. A paid `tools/call` is verified before the tool runs and
 * settled after, with the on-chain receipt attached to the response. The x402 Bazaar discovery
 * extension is advertised so the CDP facilitator catalogs the resource on first settlement.
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
    declaredExtensions?: Record<string, unknown>,
  ): Promise<Response> {
    const paymentRequired = await this.server.createPaymentRequiredResponse(
      requirements,
      resourceInfo,
      error,
      declaredExtensions,
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

    return this.chargeAndRun(c, classification.toolName, runMcp, (status, message) =>
      jsonResponse(status, {
        jsonrpc: "2.0",
        id: requestId(body),
        error: { code: -32000, message },
      }),
    );
  }

  /**
   * The x402 payment flow for one paid tool, independent of request framing.
   *
   * Shared by the MCP JSON-RPC endpoint (`/mcp`) and the per-tool HTTP routes (`/x402/<tool>`).
   * The latter exist because the x402 Bazaar only indexes plain HTTP resources — it has no
   * concept of an MCP endpoint — so each tool needs its own addressable, 402-returning URL.
   *
   * `formatError` renders non-402 failures in the caller's own envelope (JSON-RPC vs plain JSON).
   */
  async chargeAndRun(
    c: Context,
    toolName: string,
    runInner: () => Promise<Response>,
    formatError: (status: number, message: string) => Response,
    discoveryVariant: DiscoveryVariant = "mcp",
  ): Promise<Response> {
    try {
      await this.ensureInitialized();
    } catch (e) {
      return formatError(
        503,
        `Payment facilitator unavailable; cannot verify payment right now: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const spec = this.opts.specs.get(toolName);
    const price = this.opts.prices[toolName] ?? spec?.defaultPrice ?? "$0.01";
    const path = syntheticPathFor(toolName);
    // Keep the x402 `resource` lightweight: a short, ASCII, single-line description.
    // The full tool docs live in the MCP tools/list listing (the discovery surface).
    // The Coinbase CDP facilitator rejects payment payloads whose echoed
    // resource.description is long / multi-line / non-ASCII.
    // serviceName is the SERVICE, not the tool: the Bazaar groups catalog entries by it, so a
    // per-tool value would scatter these across 21 unrelated-looking listings.
    const resourceInfo: ResourceInfo = {
      url: resourceUrl(c, path),
      description: spec?.title ?? toolName,
      mimeType: "application/json",
      serviceName: SERVICE_TITLE,
    };

    // x402 Bazaar discovery: advertise the tool's I/O so CDP can catalog the resource.
    //
    // The variant matters. Declaring `type: "mcp"` makes CDP's validator skip its live probe
    // entirely ("transport type mcp cannot be validated via live probe"), leaving the resource
    // unindexed — and the catalog contains ZERO mcp-type resources, so that path is a dead end.
    // The per-tool HTTP routes therefore declare the `http` body variant, which is what actually
    // indexed sellers use and what the probe can exercise. `/mcp` keeps the mcp variant, since
    // that endpoint genuinely is MCP and is not independently indexable.
    const declaredExtensions: Record<string, unknown> | undefined = spec?.discovery
      ? discoveryVariant === "http"
        ? withDeclaredMethod(
            declareDiscoveryExtension({
              bodyType: "json",
              // The example body is validated against inputSchema by CDP; a tool with required
              // fields is rejected unless this satisfies them.
              input: spec.discovery.inputExample ?? {},
              inputSchema: spec.discovery.inputSchema,
              output: spec.discovery.output,
            }),
            "POST",
          )
        : declareDiscoveryExtension({
            toolName,
            description: spec.title,
            transport: "streamable-http",
            inputSchema: spec.discovery.inputSchema,
            output: spec.discovery.output,
          })
      : undefined;

    let requirements: PaymentRequirements[];
    try {
      requirements = await this.server.buildPaymentRequirementsFromOptions(
        [{ scheme: "exact", payTo: this.opts.payTo, price, network: this.opts.network }],
        {},
      );
    } catch (e) {
      return formatError(
        500,
        `Could not build payment requirements: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (requirements.length === 0) {
      return formatError(500, "No payment requirements available for this tool.");
    }
    const requirement = requirements[0];

    const sigHeader = c.req.header("payment-signature") ?? c.req.header("x-payment");
    if (!sigHeader) {
      return this.build402(requirements, resourceInfo, "Payment required", declaredExtensions);
    }

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(sigHeader);
    } catch {
      return this.build402(requirements, resourceInfo, "Malformed payment header", declaredExtensions);
    }

    let verify: VerifyResponse;
    try {
      verify = await this.server.verifyPayment(payload, requirement, declaredExtensions);
    } catch (e) {
      return this.build402(
        requirements,
        resourceInfo,
        `Payment verification error: ${e instanceof Error ? e.message : String(e)}`,
        declaredExtensions,
      );
    }
    if (!verify.isValid) {
      return this.build402(
        requirements,
        resourceInfo,
        verify.invalidReason ?? verify.invalidMessage ?? "Payment verification failed",
        declaredExtensions,
      );
    }

    // Verified → run the tool, then settle. If runInner throws we never settle → no charge.
    const mcpResponse = await runInner();

    // ...but `runInner()` resolving is NOT proof the tool succeeded: the MCP SDK converts a
    // thrown tool error into a *successful* HTTP response carrying `isError: true`. Pure
    // compute tools rarely fail, but network-backed tools (Treasury, BLS, on-chain RPC) fail
    // routinely on upstream 4xx/5xx, rate limits and timeouts. Settling those would charge the
    // caller for a result we never delivered, so return the error unsettled instead.
    if (await isErroredToolResult(mcpResponse)) {
      return mcpResponse;
    }

    let settle: SettleResponse;
    try {
      settle = await this.server.settlePayment(payload, requirement, declaredExtensions);
    } catch (e) {
      return this.build402(
        requirements,
        resourceInfo,
        `Settlement error: ${e instanceof Error ? e.message : String(e)}`,
        declaredExtensions,
      );
    }
    if (!settle.success) {
      return this.build402(
        requirements,
        resourceInfo,
        settle.errorReason ?? "Settlement failed",
        declaredExtensions,
      );
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

/** Build the core x402 resource server (exact EVM scheme + Bazaar discovery) backed by a facilitator. */
export async function buildResourceServer(config: AppConfig): Promise<x402ResourceServer> {
  const facilitatorConfig = await resolveFacilitatorConfig(config);
  const server = new x402ResourceServer(new HTTPFacilitatorClient(facilitatorConfig));
  registerExactEvmScheme(server);
  server.registerExtension(bazaarResourceServerExtension);
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
