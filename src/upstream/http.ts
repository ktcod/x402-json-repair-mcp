/**
 * Shared upstream HTTP access for network-backed tools.
 *
 * MONEY-SAFETY CONTRACT: a network tool MUST let `UpstreamError` propagate when its upstream
 * fails. The x402 gate treats an errored tool result as "do not settle", so the caller is never
 * charged for a call we could not fulfil. Swallowing the error and returning a partial result
 * would charge for a failure.
 */

const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Declared User-Agent. The SEC's fair-access policy explicitly requires a descriptive
 * User-Agent with contact info; Treasury and BLS behave better with one too.
 */
export const DEFAULT_USER_AGENT =
  "x402-data-mcp/0.1 (+https://x402.agentfund.net; info@agentfund.net)";

export class UpstreamError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${source} upstream failed: ${message}`);
    this.name = "UpstreamError";
  }
}

export interface FetchOpts {
  /** Short upstream label used in error messages, e.g. "BLS" or "Treasury". */
  source: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  userAgent?: string;
}

async function request(url: string, opts: FetchOpts): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      body: opts.body,
      signal: controller.signal,
      headers: {
        "user-agent": opts.userAgent ?? DEFAULT_USER_AGENT,
        accept: "application/json, text/csv, text/plain, */*",
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
    });
    if (!res.ok) {
      throw new UpstreamError(opts.source, `HTTP ${res.status}`, res.status);
    }
    return res;
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new UpstreamError(
      opts.source,
      aborted
        ? `request timed out after ${timeoutMs}ms`
        : e instanceof Error
          ? e.message
          : String(e),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts): Promise<T> {
  const res = await request(url, opts);
  try {
    return (await res.json()) as T;
  } catch {
    throw new UpstreamError(opts.source, "response body was not valid JSON");
  }
}

export async function fetchText(url: string, opts: FetchOpts): Promise<string> {
  const res = await request(url, opts);
  return res.text();
}
