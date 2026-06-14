import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import type {
  HTTPProcessResult,
  HTTPRequestContext,
  ProcessSettleResultResponse,
} from "@x402/core/server";
import type { Network } from "@x402/core/types";
import {
  PaymentGate,
  classifyRequest,
  buildToolRoutes,
  syntheticPathFor,
  type X402Processor,
} from "../src/payments/x402.js";

const PAID = new Set(["structured_json_repair"]);
const isPaid = (n: string) => PAID.has(n);
const toolCall = (name: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: {} },
});

function fakeContext(headers: Record<string, string> = {}, url = "https://svc.example/mcp"): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: { header: (n: string) => lower[n.toLowerCase()], url },
  } as unknown as Context;
}

class FakeProcessor implements X402Processor {
  initCount = 0;
  httpCalls = 0;
  settleCalls = 0;
  constructor(
    private readonly httpResult: HTTPProcessResult,
    private readonly settleResult?: ProcessSettleResultResponse,
    private readonly initError?: Error,
  ) {}
  async initialize(): Promise<void> {
    this.initCount++;
    if (this.initError) throw this.initError;
  }
  async processHTTPRequest(_ctx: HTTPRequestContext): Promise<HTTPProcessResult> {
    this.httpCalls++;
    return this.httpResult;
  }
  async processSettlement(): Promise<ProcessSettleResultResponse> {
    this.settleCalls++;
    return this.settleResult as ProcessSettleResultResponse;
  }
}

const paymentErrorResult = (): HTTPProcessResult =>
  ({
    type: "payment-error",
    response: {
      status: 402,
      headers: { "content-type": "application/json", "x-foo": "bar" },
      body: { x402Version: 1, accepts: [{ scheme: "exact" }] },
    },
  }) as unknown as HTTPProcessResult;

const verifiedResult = (): HTTPProcessResult =>
  ({
    type: "payment-verified",
    cancellationDispatcher: {},
    paymentPayload: { x402Version: 1 },
    paymentRequirements: { scheme: "exact" },
    declaredExtensions: {},
  }) as unknown as HTTPProcessResult;

const settleSuccess = (): ProcessSettleResultResponse =>
  ({
    success: true,
    transaction: "0xabc",
    network: "eip155:84532",
    payer: "0xpayer",
    headers: { "x-payment-response": "receipt123" },
    requirements: {},
  }) as unknown as ProcessSettleResultResponse;

const settleFailure = (): ProcessSettleResultResponse =>
  ({
    success: false,
    errorReason: "settlement_failed",
    headers: {},
    response: { status: 402, headers: {}, body: { error: "settlement failed" } },
  }) as unknown as ProcessSettleResultResponse;

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
    const result = classifyRequest(
      [{ method: "tools/list" }, toolCall("structured_json_repair")],
      isPaid,
    );
    expect(result.kind).toBe("batched-paid");
  });
});

describe("buildToolRoutes", () => {
  it("creates one synthetic route per paid tool with the resolved price", () => {
    const routes = buildToolRoutes(
      [{ name: "structured_json_repair", defaultPrice: "$0.01", title: "T", description: "D" }],
      {
        payTo: "0x1111111111111111111111111111111111111111",
        network: "eip155:84532" as Network,
        prices: { structured_json_repair: "$0.02" },
      },
    ) as unknown as Record<string, { accepts: Record<string, unknown> }>;
    const key = `POST ${syntheticPathFor("structured_json_repair")}`;
    expect(routes[key]).toBeDefined();
    expect(routes[key].accepts).toMatchObject({
      scheme: "exact",
      price: "$0.02",
      network: "eip155:84532",
      payTo: "0x1111111111111111111111111111111111111111",
    });
  });
});

describe("PaymentGate.evaluate", () => {
  it("passes free requests straight to MCP without touching the processor", async () => {
    const proc = new FakeProcessor(paymentErrorResult());
    const gate = new PaymentGate(proc, PAID);
    const state = { called: false };
    const res = await gate.evaluate(fakeContext(), { method: "tools/list" }, mcpRunner(state));
    expect(state.called).toBe(true);
    expect(res.status).toBe(200);
    expect(proc.initCount).toBe(0);
    expect(proc.httpCalls).toBe(0);
  });

  it("returns 402 for an unpaid paid-tool call and never runs the tool", async () => {
    const proc = new FakeProcessor(paymentErrorResult());
    const gate = new PaymentGate(proc, PAID);
    const state = { called: false };
    const res = await gate.evaluate(fakeContext(), toolCall("structured_json_repair"), mcpRunner(state));
    expect(res.status).toBe(402);
    expect(state.called).toBe(false);
    expect(proc.initCount).toBe(1);
    expect(res.headers.get("x-foo")).toBe("bar");
  });

  it("runs the tool, settles, and attaches the receipt header", async () => {
    const proc = new FakeProcessor(verifiedResult(), settleSuccess());
    const gate = new PaymentGate(proc, PAID);
    const state = { called: false };
    const res = await gate.evaluate(
      fakeContext({ "x-payment": "sig" }),
      toolCall("structured_json_repair"),
      mcpRunner(state),
    );
    expect(state.called).toBe(true);
    expect(proc.settleCalls).toBe(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-payment-response")).toBe("receipt123");
  });

  it("returns the settlement-failure response when settlement fails", async () => {
    const proc = new FakeProcessor(verifiedResult(), settleFailure());
    const gate = new PaymentGate(proc, PAID);
    const state = { called: false };
    const res = await gate.evaluate(
      fakeContext({ "x-payment": "sig" }),
      toolCall("structured_json_repair"),
      mcpRunner(state),
    );
    expect(state.called).toBe(true);
    expect(res.status).toBe(402);
  });

  it("rejects batched paid calls with HTTP 400", async () => {
    const proc = new FakeProcessor(paymentErrorResult());
    const gate = new PaymentGate(proc, PAID);
    const res = await gate.evaluate(
      fakeContext(),
      [toolCall("structured_json_repair")],
      async () => new Response("x"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 503 when the facilitator cannot initialize", async () => {
    const proc = new FakeProcessor(paymentErrorResult(), undefined, new Error("facilitator down"));
    const gate = new PaymentGate(proc, PAID);
    const res = await gate.evaluate(
      fakeContext(),
      toolCall("structured_json_repair"),
      async () => new Response("x"),
    );
    expect(res.status).toBe(503);
  });
});
