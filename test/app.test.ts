import { describe, it, expect } from "vitest";
import { app } from "../src/index.js";

const rpc = (body: unknown) =>
  app.request(
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    },
    {},
  );

/**
 * Discovery must work on a server with NO payment configuration.
 *
 * Directory listings (Glama, and anything else that boots the container to introspect it) start
 * the server with no secrets and call tools/list. If that path required PAYOUT_WALLET_ADDRESS the
 * server would look broken to every automated check, and to anyone running a fresh clone.
 */
describe("MCP endpoint without payment configuration", () => {
  it("answers tools/list", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: unknown[] }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect((body.result?.tools ?? []).length).toBeGreaterThan(0);
  });

  it("answers initialize", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(res.status).toBe(200);
  });

  it("still refuses a PAID tool call rather than serving it free", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "onchain_gas", arguments: {} },
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    expect(body.result).toBeUndefined();
    expect(body.error?.message).toMatch(/PAYOUT_WALLET_ADDRESS/);
  });
});

describe("per-tool HTTP routes", () => {
  it("404s an unknown tool and names the real ones", async () => {
    const res = await app.request("/x402/not_a_real_tool", { method: "GET" }, {});
    expect(res.status).toBe(404);
    const body = (await res.json()) as { availableTools?: string[] };
    expect(body.availableTools).toContain("onchain_gas");
  });
});

describe("discovery documents", () => {
  it("describes every paid tool with payment info and a 402", async () => {
    const res = await app.request("/openapi.json", { method: "GET" }, {});
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi?: string;
      paths?: Record<string, { post: Record<string, unknown> }>;
    };
    expect(doc.openapi).toBe("3.1.0");
    const paths = Object.keys(doc.paths ?? {});
    expect(paths.length).toBeGreaterThan(0);
    // Indexers reject an origin whose payable operations omit either of these.
    for (const p of paths) {
      const op = doc.paths![p].post;
      expect(op["x-payment-info"]).toBeDefined();
      expect((op.responses as Record<string, unknown>)["402"]).toBeDefined();
    }
  });

  it("serves SKILL.md and VERIFICATION.md as markdown", async () => {
    for (const path of ["/SKILL.md", "/VERIFICATION.md"]) {
      const res = await app.request(path, { method: "GET" }, {});
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect((await res.text()).length).toBeGreaterThan(500);
    }
  });
});
