import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import {
  encodePaymentSignatureHeader,
  decodePaymentRequiredHeader,
} from "@x402/core/http";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  PaymentRequired,
  ResourceInfo,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import { PaymentGate, classifyRequest, syntheticPathFor, type ResourceServerLike } from "../src/payments/x402.js";
import type { PaidToolSpec } from "../src/tools/index.js";

const PAID = new Set(["structured_json_repair"]);
const isPaid = (n: string) => PAID.has(n);
const PAYTO = "0xe22F691ed420143BfdAB022A14e7d6873b33EEf9";
const NETWORK = "eip155:8453" as Network;
const SPECS = new Map<string, PaidToolSpec>([
  ["structured_json_repair", { name: "structured_json_repair", defaultPrice: "$0.01", title: "T", description: "D" }],
]);

const toolCall = (name: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: {} },
});

function fakeContext(headers: Record<string, string> = {}, url = "https://svc.example/mcp"): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { req: { header: (n: string) => lower[n.toLowerCase()], url } } as unknown as Context;
}

const REQUIREMENT: PaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "10000",
  payTo: PAYTO,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};

/** A real, decodable payment-signature header (round-tripped through the lib encoder). */
function paymentHeader(): string {
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://svc.example/x402/structured_json_repair", description: "D", mimeType: "application/json" },
    accepted: REQUIREMENT,
    payload: {
      authorization: {
        from: "0x09cfA2568EBeb09693E7941E59dD9caE5E94164a",
        to: PAYTO,
        value: "10000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0x" + "1".repeat(64),
      },
      signature: "0x" + "2".repeat(130),
    },
  };
  return encodePaymentSignatureHeader(payload);
}

class FakeServer implements ResourceServerLike {
  initCount = 0;
  verifyCount = 0;
  settleCount = 0;
  constructor(
    private readonly opts: { verify?: VerifyResponse; settle?: SettleResponse; initError?: Error } = {},
  ) {}
  async initialize(): Promise<void> {
    this.initCount++;
    if (this.opts.initError) throw this.opts.initError;
  }
  async buildPaymentRequirementsFromOptions(
    options: Array<{ payTo: string; network: Network }>,
  ): Promise<PaymentRequirements[]> {
    return [{ ...REQUIREMENT, payTo: options[0].payTo, network: options[0].network }];
  }
  async createPaymentRequiredResponse(
    requirements: PaymentRequirements[],
    resourceInfo: ResourceInfo,
    error?: string,
  ): Promise<PaymentRequired> {
    return { x402Version: 2, error, resource: resourceInfo, accepts: requirements };
  }
  async verifyPayment(): Promise<VerifyResponse> {
    this.verifyCount++;
    return this.opts.verify ?? ({ isValid: true } as VerifyResponse);
  }
  async settlePayment(): Promise<SettleResponse> {
    this.settleCount++;
    return (
      this.opts.settle ??
      ({ success: true, transaction: "0xabc", network: NETWORK, payer: "0xpayer" } as unknown as SettleResponse)
    );
  }
}

function makeGate(server: ResourceServerLike): PaymentGate {
  return new PaymentGate(server, PAID, { payTo: PAYTO, network: NETWORK, prices: {}, specs: SPECS });
}

function mcpRunner(state: { called: boolean }) {
  return async () => {
    state.called = true;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("classifyRequest", () => {
  it("treats discovery & lifecycle methods as free", () => {
    expect(classifyRequest({ method: "initialize" }, isPaid).kind).toBe("free");
    expect(classifyRequest({ method: "tools/list" }, isPaid).kind).toBe("free");
    expect(classifyRequest({ method: "ping" }, isPaid).kind).toBe("free");
    expect(classifyRequest({ method: "notifications/initialized" }, isPaid).kind).toBe("free");
  });
  it("treats a call to a non-paid tool as free", () => {
    expect(classifyRequest(toolCall("some_free_tool"), isPaid).kind).toBe("free");
  });
  it("flags a paid tool call", () => {
    expect(classifyRequest(toolCall("structured_json_repair"), isPaid)).toEqual({
      kind: "paid",
      toolName: "structured_json_repair",
    });
  });
  it("flags a batch that contains a paid call", () => {
    expect(classifyRequest([{ method: "tools/list" }, toolCall("structured_json_repair")], isPaid).kind).toBe(
      "batched-paid",
    );
  });
});

describe("payment-signature header round-trip", () => {
  it("produces a header the gate can decode", () => {
    const h = paymentHeader();
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });
});

describe("PaymentGate.evaluate", () => {
  it("passes free requests straight to MCP without touching the server", async () => {
    const server = new FakeServer();
    const gate = makeGate(server);
    const state = { called: false };
    const res = await gate.evaluate(fakeContext(), { method: "tools/list" }, mcpRunner(state));
    expect(state.called).toBe(true);
    expect(res.status).toBe(200);
    expect(server.initCount).toBe(0);
    expect(server.verifyCount).toBe(0);
  });

  it("returns 402 with a payment-required header when no payment is supplied", async () => {
    const server = new FakeServer();
    const gate = makeGate(server);
    const state = { called: false };
    const res = await gate.evaluate(fakeContext(), toolCall("structured_json_repair"), mcpRunner(state));
    expect(res.status).toBe(402);
    expect(state.called).toBe(false);
    expect(server.initCount).toBe(1);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = decodePaymentRequiredHeader(header as string);
    expect(decoded.accepts[0].payTo).toBe(PAYTO);
    expect(server.verifyCount).toBe(0);
  });

  it("verifies, runs the tool, settles, and attaches the receipt", async () => {
    const server = new FakeServer({ verify: { isValid: true } as VerifyResponse });
    const gate = makeGate(server);
    const state = { called: false };
    const res = await gate.evaluate(
      fakeContext({ "payment-signature": paymentHeader() }),
      toolCall("structured_json_repair"),
      mcpRunner(state),
    );
    expect(server.verifyCount).toBe(1);
    expect(state.called).toBe(true);
    expect(server.settleCount).toBe(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-response")).toBeTruthy();
  });

  it("returns 402 and does NOT run the tool when verification fails", async () => {
    const server = new FakeServer({
      verify: { isValid: false, invalidReason: "insufficient_balance" } as VerifyResponse,
    });
    const gate = makeGate(server);
    const state = { called: false };
    const res = await gate.evaluate(
      fakeContext({ "payment-signature": paymentHeader() }),
      toolCall("structured_json_repair"),
      mcpRunner(state),
    );
    expect(res.status).toBe(402);
    expect(state.called).toBe(false);
    expect(server.settleCount).toBe(0);
  });

  it("returns 402 when settlement fails (after running the tool)", async () => {
    const server = new FakeServer({
      verify: { isValid: true } as VerifyResponse,
      settle: { success: false, errorReason: "settle_failed" } as unknown as SettleResponse,
    });
    const gate = makeGate(server);
    const state = { called: false };
    const res = await gate.evaluate(
      fakeContext({ "payment-signature": paymentHeader() }),
      toolCall("structured_json_repair"),
      mcpRunner(state),
    );
    expect(state.called).toBe(true);
    expect(res.status).toBe(402);
  });

  it("rejects batched paid calls with HTTP 400", async () => {
    const gate = makeGate(new FakeServer());
    const res = await gate.evaluate(fakeContext(), [toolCall("structured_json_repair")], async () => new Response("x"));
    expect(res.status).toBe(400);
  });

  it("returns 503 when the facilitator cannot initialize", async () => {
    const gate = makeGate(new FakeServer({ initError: new Error("facilitator down") }));
    const res = await gate.evaluate(fakeContext(), toolCall("structured_json_repair"), async () => new Response("x"));
    expect(res.status).toBe(503);
  });

  it("maps tool names to synthetic resource paths", () => {
    expect(syntheticPathFor("structured_json_repair")).toBe("/x402/structured_json_repair");
  });
});

/**
 * Network-backed tools (Treasury, BLS, on-chain RPC) fail routinely on upstream errors, rate
 * limits and timeouts. The MCP SDK reports a failed tool as HTTP 200 + `isError: true`, so the
 * gate must inspect the result and refuse to settle. Otherwise callers pay for nothing.
 */
describe("PaymentGate does not settle a failed tool call", () => {
  const errorRunner = (body: string, contentType = "application/json") => async () =>
    new Response(body, { status: 200, headers: { "content-type": contentType } });

  it("skips settlement when the tool result has isError: true", async () => {
    const server = new FakeServer({ verify: { isValid: true } as VerifyResponse });
    const gate = makeGate(server);
    const res = await gate.evaluate(
      fakeContext({ "payment-signature": paymentHeader() }),
      toolCall("structured_json_repair"),
      errorRunner(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "Treasury upstream failed: HTTP 503" }],
            isError: true,
          },
        }),
      ),
    );
    expect(server.verifyCount).toBe(1);
    expect(server.settleCount).toBe(0);
    expect(res.headers.get("payment-response")).toBeNull();
  });

  it("skips settlement for an isError result delivered over SSE", async () => {
    const server = new FakeServer({ verify: { isValid: true } as VerifyResponse });
    const gate = makeGate(server);
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true } });
    const res = await gate.evaluate(
      fakeContext({ "payment-signature": paymentHeader() }),
      toolCall("structured_json_repair"),
      errorRunner(`event: message\ndata: ${frame}\n\n`, "text/event-stream"),
    );
    expect(server.settleCount).toBe(0);
    expect(res.status).toBe(200);
  });

  it("skips settlement when the response is a JSON-RPC error", async () => {
    const server = new FakeServer({ verify: { isValid: true } as VerifyResponse });
    const gate = makeGate(server);
    await gate.evaluate(
      fakeContext({ "payment-signature": paymentHeader() }),
      toolCall("structured_json_repair"),
      errorRunner(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } })),
    );
    expect(server.settleCount).toBe(0);
  });

  it("still settles a successful result (regression guard)", async () => {
    const server = new FakeServer({ verify: { isValid: true } as VerifyResponse });
    const gate = makeGate(server);
    const res = await gate.evaluate(
      fakeContext({ "payment-signature": paymentHeader() }),
      toolCall("structured_json_repair"),
      errorRunner(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], isError: false } })),
    );
    expect(server.settleCount).toBe(1);
    expect(res.headers.get("payment-response")).toBeTruthy();
  });
});

/**
 * chargeAndRun backs the per-tool `/x402/<tool>` HTTP routes, which exist because the x402
 * Bazaar indexes plain HTTP resources only and cannot see an MCP endpoint. It must apply the
 * SAME money-safety rules as the JSON-RPC path while rendering errors in the caller's envelope.
 */
describe("PaymentGate.chargeAndRun (per-tool HTTP routes)", () => {
  /** Inner runner returning a fixed body, for asserting settle/no-settle behaviour. */
  const bodyRunner = (body: string) => async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });

  /** Plain-JSON error envelope, as the HTTP routes use (not JSON-RPC). */
  const plainError = (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("returns 402 and does not run the tool when payment is absent", async () => {
    const server = new FakeServer();
    const gate = makeGate(server);
    const state = { called: false };
    const res = await gate.chargeAndRun(
      fakeContext(),
      "structured_json_repair",
      mcpRunner(state),
      plainError,
    );
    expect(res.status).toBe(402);
    expect(state.called).toBe(false);
    expect(server.settleCount).toBe(0);
  });

  it("advertises the synthetic resource path in the 402", async () => {
    const gate = makeGate(new FakeServer());
    const res = await gate.chargeAndRun(
      fakeContext(),
      "structured_json_repair",
      mcpRunner({ called: false }),
      plainError,
    );
    const decoded = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
    expect(decoded.resource.url).toContain(syntheticPathFor("structured_json_repair"));
  });

  it("renders non-402 failures via the caller's formatter, not JSON-RPC", async () => {
    const server = new FakeServer({ initError: new Error("facilitator down") });
    const gate = makeGate(server);
    const res = await gate.chargeAndRun(
      fakeContext({ "payment-signature": paymentHeader() }),
      "structured_json_repair",
      mcpRunner({ called: false }),
      plainError,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; jsonrpc?: string };
    expect(body.error).toContain("facilitator down");
    expect(body.jsonrpc).toBeUndefined();
  });

  it("settles a successful call and attaches the receipt", async () => {
    const server = new FakeServer({ verify: { isValid: true } as VerifyResponse });
    const gate = makeGate(server);
    const state = { called: false };
    const res = await gate.chargeAndRun(
      fakeContext({ "payment-signature": paymentHeader() }),
      "structured_json_repair",
      mcpRunner(state),
      plainError,
    );
    expect(state.called).toBe(true);
    expect(server.settleCount).toBe(1);
    expect(res.headers.get("payment-response")).toBeTruthy();
  });

  it("does NOT settle when the tool reports isError (no charge for a failed upstream)", async () => {
    const server = new FakeServer({ verify: { isValid: true } as VerifyResponse });
    const gate = makeGate(server);
    const res = await gate.chargeAndRun(
      fakeContext({ "payment-signature": paymentHeader() }),
      "structured_json_repair",
      bodyRunner(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], isError: true } })),
      plainError,
    );
    expect(server.settleCount).toBe(0);
    expect(res.headers.get("payment-response")).toBeNull();
  });
});
