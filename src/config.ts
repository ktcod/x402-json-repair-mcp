import type { Network } from "@x402/core/types";

export type X402Mode = "sandbox" | "production";

export type Env = Record<string, string | undefined>;

export interface ToolPriceSpec {
  name: string;
  defaultPrice: string;
}

export interface AppConfig {
  /** Public payout address (USDC on Base). Never a private key. */
  payTo: `0x${string}`;
  network: Network;
  mode: X402Mode;
  facilitatorUrl: string;
  useCdp: boolean;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  /** toolName -> normalized USD price (e.g. "$0.01"). */
  prices: Record<string, string>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const BASE_MAINNET = "eip155:8453" as Network;
const BASE_SEPOLIA = "eip155:84532" as Network;
const DEFAULT_TESTNET_FACILITATOR = "https://x402.org/facilitator";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export function priceEnvVar(toolName: string): string {
  return "PRICE_" + toolName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function redactAddress(value: string): string {
  if (value.length <= 12) return "***";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function normalizePrice(value: string, toolName: string): string {
  const trimmed = value.trim();
  if (!/^\$?\d+(\.\d+)?$/.test(trimmed)) {
    throw new ConfigError(
      `Invalid price "${value}" for tool "${toolName}". Use a USD amount such as "$0.01".`,
    );
  }
  return trimmed.startsWith("$") ? trimmed : `$${trimmed}`;
}

/**
 * Resolve and validate the payout address. Hard rule: ADDRESS ONLY — this function
 * actively refuses anything that looks like a private key or seed phrase.
 */
export function resolvePayoutAddress(raw: string | undefined): `0x${string}` {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new ConfigError(
      "PAYOUT_WALLET_ADDRESS is required. Set it to your PUBLIC USDC payout address on Base " +
        "(0x followed by 40 hex characters). Never set a private key.",
    );
  }
  if (/\s/.test(value)) {
    throw new ConfigError(
      "PAYOUT_WALLET_ADDRESS must be a single 0x address, not a phrase. Never use a seed phrase or mnemonic.",
    );
  }
  if (!ADDRESS_RE.test(value) && PRIVATE_KEY_RE.test(value)) {
    throw new ConfigError(
      "PAYOUT_WALLET_ADDRESS looks like a private key (64 hex chars). Refusing to start. " +
        "Provide the PUBLIC wallet address (0x + 40 hex chars) only — this server never needs a private key.",
    );
  }
  if (!ADDRESS_RE.test(value)) {
    throw new ConfigError(
      `PAYOUT_WALLET_ADDRESS is not a valid EVM address: "${redactAddress(value)}". ` +
        "Expected 0x followed by 40 hex characters.",
    );
  }
  return value as `0x${string}`;
}

export function loadConfig(env: Env, paidTools: ToolPriceSpec[]): AppConfig {
  const payTo = resolvePayoutAddress(env.PAYOUT_WALLET_ADDRESS);

  const mode: X402Mode =
    (env.X402_MODE ?? "sandbox").trim().toLowerCase() === "production" ? "production" : "sandbox";

  const network = (env.X402_NETWORK?.trim() ||
    (mode === "production" ? BASE_MAINNET : BASE_SEPOLIA)) as Network;
  if (network !== BASE_MAINNET && network !== BASE_SEPOLIA) {
    throw new ConfigError(
      `X402_NETWORK must be "${BASE_MAINNET}" (Base mainnet) or "${BASE_SEPOLIA}" (Base Sepolia testnet). Got "${network}".`,
    );
  }

  const cdpApiKeyId = env.CDP_API_KEY_ID?.trim() || undefined;
  const cdpApiKeySecret = env.CDP_API_KEY_SECRET?.trim() || undefined;
  const explicitCdp = (env.X402_USE_CDP_FACILITATOR ?? "").trim().toLowerCase() === "true";
  const useCdp = explicitCdp || (mode === "production" && !env.X402_FACILITATOR_URL && Boolean(cdpApiKeyId));
  if (useCdp && (!cdpApiKeyId || !cdpApiKeySecret)) {
    throw new ConfigError(
      "Coinbase CDP facilitator selected but CDP_API_KEY_ID and/or CDP_API_KEY_SECRET are not set. " +
        "Set both (via `wrangler secret put`) or unset X402_USE_CDP_FACILITATOR to use a URL facilitator.",
    );
  }

  const facilitatorUrl = env.X402_FACILITATOR_URL?.trim() || DEFAULT_TESTNET_FACILITATOR;

  const prices: Record<string, string> = {};
  for (const tool of paidTools) {
    prices[tool.name] = normalizePrice(env[priceEnvVar(tool.name)] ?? tool.defaultPrice, tool.name);
  }

  return { payTo, network, mode, facilitatorUrl, useCdp, cdpApiKeyId, cdpApiKeySecret, prices };
}
