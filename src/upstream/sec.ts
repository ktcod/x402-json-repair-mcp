/**
 * Shared SEC EDGAR access.
 *
 * EDGAR is free and public domain, with two operating rules we honour:
 *  - a descriptive User-Agent is required (see upstream/http.ts DEFAULT_USER_AGENT)
 *  - fair access caps requests at 10/second, so tools bound how many documents they fetch
 */
import { fetchJson, UpstreamError } from "./http.js";

export const SEC_SOURCE = "SEC EDGAR";
export const SEC_SOURCE_URL = "https://www.sec.gov/edgar";
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/** The ticker map is ~800 KB and changes rarely, so memoize it per isolate. */
let tickerCache: { at: number; map: Map<string, { cik: number; title: string }> } | undefined;
const TICKER_TTL_MS = 24 * 60 * 60 * 1000;

/** Exposed for tests so a stale cache cannot leak between cases. */
export function resetTickerCache(): void {
  tickerCache = undefined;
}

async function tickerMap(): Promise<Map<string, { cik: number; title: string }>> {
  if (!tickerCache || Date.now() - tickerCache.at > TICKER_TTL_MS) {
    const body = await fetchJson<Record<string, TickerEntry>>(TICKER_MAP_URL, {
      source: SEC_SOURCE,
      timeoutMs: 20_000,
    });
    const map = new Map<string, { cik: number; title: string }>();
    for (const entry of Object.values(body)) {
      if (entry?.ticker) {
        map.set(entry.ticker.toUpperCase(), { cik: entry.cik_str, title: entry.title });
      }
    }
    if (map.size === 0) {
      throw new UpstreamError(SEC_SOURCE, "ticker map came back empty");
    }
    tickerCache = { at: Date.now(), map };
  }
  return tickerCache.map;
}

/** Zero-pad a CIK to the 10-digit form EDGAR's JSON endpoints expect. */
export function padCik(cik: number | string): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

/**
 * Resolve a ticker symbol OR a bare CIK to a numeric CIK.
 * Accepting both means callers never have to look up a CIK themselves.
 */
export async function resolveCik(tickerOrCik: string): Promise<{ cik: number; title?: string }> {
  const raw = (tickerOrCik ?? "").trim();
  if (!raw) throw new UpstreamError(SEC_SOURCE, "a ticker or CIK is required");
  if (/^\d+$/.test(raw)) return { cik: Number(raw) };

  const hit = (await tickerMap()).get(raw.toUpperCase());
  if (!hit) {
    throw new UpstreamError(SEC_SOURCE, `no SEC filer found for ticker "${raw.toUpperCase()}"`);
  }
  return { cik: hit.cik, title: hit.title };
}

export interface SecSubmissions {
  name?: string;
  tickers?: string[];
  sic?: string;
  sicDescription?: string;
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      reportDate?: string[];
      accessionNumber?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
      items?: string[];
    };
  };
}

export async function fetchSubmissions(cik: number): Promise<SecSubmissions> {
  const padded = padCik(cik);
  const subs = await fetchJson<SecSubmissions>(
    `https://data.sec.gov/submissions/CIK${padded}.json`,
    { source: SEC_SOURCE, timeoutMs: 20_000 },
  );
  if (!subs.filings?.recent?.form) {
    throw new UpstreamError(SEC_SOURCE, `no filing history returned for CIK ${padded}`);
  }
  return subs;
}

export interface RecentFiling {
  form: string;
  filedAt: string;
  reportDate: string | null;
  accession: string;
  primaryDocument: string;
  description: string | null;
  /** 8-K item numbers, when present. */
  items: string | null;
}

/** Flatten EDGAR's column-oriented "recent filings" into rows, newest first. */
export function recentFilings(subs: SecSubmissions, forms?: string[], limit = 20): RecentFiling[] {
  const r = subs.filings?.recent;
  if (!r?.form) return [];
  const wanted = forms?.length ? new Set(forms.map((f) => f.trim().toUpperCase())) : undefined;
  const out: RecentFiling[] = [];
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    const form = (r.form[i] ?? "").toUpperCase();
    if (wanted && !wanted.has(form)) continue;
    out.push({
      form,
      filedAt: r.filingDate?.[i] ?? "",
      reportDate: r.reportDate?.[i] || null,
      accession: r.accessionNumber?.[i] ?? "",
      primaryDocument: r.primaryDocument?.[i] ?? "",
      description: r.primaryDocDescription?.[i] || null,
      items: r.items?.[i] || null,
    });
  }
  return out;
}

/** Public URL for a filing's primary document. */
export function filingUrl(cik: number, accession: string, primaryDocument: string): string {
  const acc = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${primaryDocument}`;
}

/** Filing index page, useful when the primary document is unhelpful. */
export function filingIndexUrl(cik: number, accession: string): string {
  const acc = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/`;
}
