/**
 * Minimal EVM JSON-RPC access for on-chain tools.
 *
 * Deliberately dependency-free: we hand-encode the two or three ERC-20 calls we need and use
 * JSON-RPC *batching* (verified working on Base's public endpoints) instead of Multicall3 ABI
 * encoding. That keeps the Cloudflare Workers bundle small and avoids promoting viem from a
 * dev dependency to a runtime one.
 *
 * Public RPC endpoints rate-limit aggressively, so every call rotates through a list of
 * providers and only throws once all of them fail.
 */
import { fetchJson, UpstreamError } from "./http.js";

export interface ChainSpec {
  id: number;
  name: string;
  /** Canonical USDC contract on this chain, used as the default token. */
  usdc: string;
  rpcs: string[];
}

export const CHAINS = {
  base: {
    id: 8453,
    name: "Base",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcs: [
      "https://base-rpc.publicnode.com",
      "https://base.drpc.org",
      "https://1rpc.io/base",
      "https://mainnet.base.org",
    ],
  },
  ethereum: {
    id: 1,
    name: "Ethereum",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://1rpc.io/eth"],
  },
  optimism: {
    id: 10,
    name: "Optimism",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    rpcs: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
  },
  arbitrum: {
    id: 42161,
    name: "Arbitrum One",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
  },
  polygon: {
    id: 137,
    name: "Polygon",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  },
} as const satisfies Record<string, ChainSpec>;

export type ChainKey = keyof typeof CHAINS;
export const CHAIN_KEYS = Object.keys(CHAINS) as ChainKey[];

/** Function selectors for the ERC-20 / Chainlink reads we perform. */
export const SELECTOR = {
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  latestRoundData: "0xfeaf968c",
} as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Most public endpoints cap batch size; 100 is comfortably supported. */
const MAX_BATCH = 100;

export function assertAddress(value: string, label = "address"): string {
  const v = (value ?? "").trim();
  if (!ADDRESS_RE.test(v)) {
    throw new UpstreamError("EVM", `${label} is not a valid EVM address: "${v.slice(0, 12)}…"`);
  }
  return v.toLowerCase();
}

/** Left-pad an address into a 32-byte ABI word. */
export function padAddress(address: string): string {
  return "0".repeat(24) + assertAddress(address).slice(2);
}

export function encodeBalanceOf(holder: string): string {
  return SELECTOR.balanceOf + padAddress(holder);
}

export function hexToBigInt(hex: string | null | undefined): bigint | null {
  if (!hex || hex === "0x") return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

/**
 * Decode an ABI-encoded return value as a string. Handles the dynamic `string` layout and the
 * legacy `bytes32` symbols some older tokens return.
 */
export function decodeAbiString(hex: string | null | undefined): string | null {
  if (!hex || hex === "0x") return null;
  const body = hex.slice(2);
  const toAscii = (h: string): string =>
    (h.match(/.{2}/g) ?? [])
      .map((b) => parseInt(b, 16))
      .filter((c) => c >= 32 && c < 127)
      .map((c) => String.fromCharCode(c))
      .join("");
  // Dynamic string layout: [offset][length][data...]
  if (body.length >= 128) {
    const length = Number(BigInt("0x" + body.slice(64, 128)));
    if (Number.isFinite(length) && length > 0 && length <= 256) {
      const decoded = toAscii(body.slice(128, 128 + length * 2)).trim();
      if (decoded) return decoded;
    }
  }
  const fallback = toAscii(body).trim();
  return fallback || null;
}

/** Format a raw integer amount using its token decimals, without floating-point loss. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export interface RpcRequest {
  method: string;
  params: unknown[];
}
interface RpcResponse {
  id?: number;
  result?: string;
  error?: { message?: string };
}

function rpcUrls(chain: ChainKey, env?: Record<string, string | undefined>): string[] {
  const override = env?.[`EVM_RPC_${chain.toUpperCase()}`];
  const custom = override ? override.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return [...custom, ...CHAINS[chain].rpcs];
}

/**
 * Send a batch of JSON-RPC calls in ONE HTTP request, chunked to `MAX_BATCH`.
 * Returns results aligned to the input order; an individual failed call yields null.
 * Throws UpstreamError only when every configured provider rejects the request.
 */
export async function rpcBatch(
  chain: ChainKey,
  requests: RpcRequest[],
  env?: Record<string, string | undefined>,
): Promise<Array<string | null>> {
  if (requests.length === 0) return [];
  const urls = rpcUrls(chain, env);
  const out: Array<string | null> = new Array(requests.length).fill(null);

  for (let start = 0; start < requests.length; start += MAX_BATCH) {
    const chunk = requests.slice(start, start + MAX_BATCH);
    const body = JSON.stringify(
      chunk.map((r, i) => ({ jsonrpc: "2.0", id: i, method: r.method, params: r.params })),
    );

    let settled = false;
    let lastError: unknown;
    for (const url of urls) {
      try {
        const res = await fetchJson<RpcResponse[] | RpcResponse>(url, {
          source: `${CHAINS[chain].name} RPC`,
          method: "POST",
          body,
        });
        for (const row of Array.isArray(res) ? res : [res]) {
          const idx = typeof row.id === "number" ? row.id : -1;
          if (idx >= 0 && idx < chunk.length && !row.error) {
            out[start + idx] = row.result ?? null;
          }
        }
        settled = true;
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!settled) {
      throw new UpstreamError(
        `${CHAINS[chain].name} RPC`,
        `all ${urls.length} providers failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
  }
  return out;
}

/** Convenience: a single eth_call returning raw hex. */
export async function ethCall(
  chain: ChainKey,
  to: string,
  data: string,
  env?: Record<string, string | undefined>,
): Promise<string | null> {
  const [result] = await rpcBatch(
    chain,
    [{ method: "eth_call", params: [{ to, data }, "latest"] }],
    env,
  );
  return result;
}

export interface Erc20Meta {
  address: string;
  symbol: string | null;
  decimals: number;
}

/** Read a token's symbol and decimals in one batched request. Defaults decimals to 18. */
export async function erc20Meta(
  chain: ChainKey,
  token: string,
  env?: Record<string, string | undefined>,
): Promise<Erc20Meta> {
  const address = assertAddress(token, "token");
  const [decRaw, symRaw] = await rpcBatch(
    chain,
    [
      { method: "eth_call", params: [{ to: address, data: SELECTOR.decimals }, "latest"] },
      { method: "eth_call", params: [{ to: address, data: SELECTOR.symbol }, "latest"] },
    ],
    env,
  );
  const decimals = hexToBigInt(decRaw);
  return {
    address,
    symbol: decodeAbiString(symRaw),
    decimals: decimals === null ? 18 : Number(decimals),
  };
}
