import { ethCall, encodeBalanceOf, hexToBigInt, formatUnits, CHAINS } from "./upstream/evm.js";
import { fetchJson } from "./upstream/http.js";
import type { PaidToolSpec } from "./tools/index.js";

/**
 * Live settlement monitor for the payout wallet.
 *
 * Settlement history comes from Blockscout rather than `eth_getLogs`: Base's public RPCs cap log
 * queries at 10k blocks (~5.5 hours), so on-chain history is simply unreachable that way, while
 * Blockscout returns the full ERC-20 transfer history keylessly in one request.
 *
 * The balance is read straight from the USDC contract — it is the number that actually matters,
 * and it stays correct even when the indexer lags or is down.
 */

const SOURCE = "Blockscout";
const BLOCKSCOUT = "https://base.blockscout.com/api/v2";
const USDC_DECIMALS = 6;

interface BlockscoutTransfer {
  timestamp?: string;
  transaction_hash?: string;
  from?: { hash?: string };
  to?: { hash?: string };
  token?: { symbol?: string; address?: string };
  total?: { value?: string; decimals?: string | number };
}

export interface Settlement {
  /** ISO-8601 UTC, as reported by the indexer. */
  timestamp: string | null;
  amountUsdc: number;
  txHash: string | null;
  payer: string | null;
  /** Tool inferred from the amount when exactly one tool carries that price. */
  tool: string | null;
  /** Every tool sharing that price — populated when the amount is ambiguous. */
  toolCandidates: string[];
}

export interface MonitorSnapshot {
  payTo: string;
  network: string;
  balanceUsdc: number | null;
  settledCount: number;
  settledUsdc: number;
  lastSettledAt: string | null;
  settlements: Settlement[];
  /** Non-fatal degradations, so a partial page never masquerades as a healthy one. */
  warnings: string[];
}

/** Map a settled amount back to the tool(s) priced at exactly that value. */
export function toolsForAmount(amountUsdc: number, specs: PaidToolSpec[]): string[] {
  const atomic = Math.round(amountUsdc * 1e6);
  return specs
    .filter((s) => Math.round(Number(s.defaultPrice.replace(/^\$/, "")) * 1e6) === atomic)
    .map((s) => s.name);
}

/** Normalize Blockscout's transfer list into settlements. Pure; no network. */
export function toSettlements(
  items: BlockscoutTransfer[],
  payTo: string,
  specs: PaidToolSpec[],
): Settlement[] {
  const target = payTo.toLowerCase();
  const out: Settlement[] = [];
  for (const t of items) {
    // Count only value arriving AT the payout address; the endpoint also lists outbound sends.
    if ((t.to?.hash ?? "").toLowerCase() !== target) continue;
    const decimals = Number(t.total?.decimals ?? USDC_DECIMALS);
    const raw = t.total?.value;
    if (!raw) continue;
    const amount = Number(raw) / 10 ** (Number.isFinite(decimals) ? decimals : USDC_DECIMALS);
    if (!Number.isFinite(amount)) continue;
    const candidates = toolsForAmount(amount, specs);
    out.push({
      timestamp: t.timestamp ?? null,
      amountUsdc: amount,
      txHash: t.transaction_hash ?? null,
      payer: t.from?.hash ?? null,
      tool: candidates.length === 1 ? candidates[0] : null,
      toolCandidates: candidates,
    });
  }
  return out.sort((a, b) => ((a.timestamp ?? "") < (b.timestamp ?? "") ? 1 : -1));
}

async function fetchBalance(payTo: string): Promise<number | null> {
  const hex = await ethCall("base", CHAINS.base.usdc, encodeBalanceOf(payTo));
  const raw = hexToBigInt(hex);
  return raw === null ? null : Number(formatUnits(raw, USDC_DECIMALS));
}

export async function buildSnapshot(
  payTo: string,
  specs: PaidToolSpec[],
): Promise<MonitorSnapshot> {
  const warnings: string[] = [];

  // Balance and history fail independently — one being down must not blank the whole page.
  const [balance, transfers] = await Promise.all([
    fetchBalance(payTo).catch((e) => {
      warnings.push(`balance unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }),
    fetchJson<{ items?: BlockscoutTransfer[] }>(
      `${BLOCKSCOUT}/addresses/${payTo}/token-transfers?type=ERC-20`,
      { source: SOURCE },
    ).catch((e) => {
      warnings.push(
        `settlement history unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { items: [] as BlockscoutTransfer[] };
    }),
  ]);

  const settlements = toSettlements(transfers.items ?? [], payTo, specs);
  return {
    payTo,
    network: "base",
    balanceUsdc: balance,
    settledCount: settlements.length,
    settledUsdc: settlements.reduce((sum, s) => sum + s.amountUsdc, 0),
    lastSettledAt: settlements[0]?.timestamp ?? null,
    settlements,
    warnings,
  };
}

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (ch) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[ch]};`,
  );

/**
 * Self-contained dashboard. Data is polled client-side from /monitor.json so the view refreshes
 * without a reload; the first snapshot is inlined so the page renders with content on first paint.
 */
export function renderMonitorHtml(snapshot: MonitorSnapshot, toolCount: number): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Settlements &mdash; AgentFund x402</title>
<link rel="icon" href="/favicon.ico">
<style>
  :root{--bg:#080b12;--card:#0d1220;--line:#1b2436;--dim:#64748b;--fg:#e2e8f0;--accent:#22c55e}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:24px}
  .wrap{max-width:920px;margin:0 auto}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px}
  .top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;
       font-size:11px;letter-spacing:.14em;color:var(--dim);text-transform:uppercase}
  .dot{color:var(--accent)}
  h1{font:600 46px/1.1 ui-serif,Georgia,serif;margin:14px 0 2px;letter-spacing:-.02em}
  .sub{font-size:11px;letter-spacing:.14em;color:var(--dim);text-transform:uppercase}
  .stats{display:flex;gap:34px;margin:20px 0 4px;flex-wrap:wrap}
  .stat b{display:block;font:600 20px/1.3 ui-serif,Georgia,serif}
  .stat span{font-size:10px;letter-spacing:.12em;color:var(--dim);text-transform:uppercase}
  table{width:100%;border-collapse:collapse;margin-top:18px}
  th{font-size:10px;letter-spacing:.12em;color:var(--dim);text-transform:uppercase;
     text-align:left;font-weight:400;padding:8px 10px;border-bottom:1px solid var(--line)}
  td{padding:11px 10px;border-bottom:1px solid var(--line);font-size:13px;white-space:nowrap}
  tr:last-child td{border-bottom:0}
  .num{text-align:right}
  a{color:var(--fg);text-decoration:none;border-bottom:1px dotted var(--dim)}
  a:hover{color:var(--accent)}
  .muted{color:var(--dim)}
  .warn{margin-top:14px;padding:10px 12px;border:1px solid #7c2d12;background:#1c0f0a;
        border-radius:8px;color:#fdba74;font-size:12px}
  .empty{padding:26px 10px;color:var(--dim);white-space:normal}
  .foot{display:flex;justify-content:space-between;margin-top:18px;font-size:11px;
        letter-spacing:.1em;color:var(--dim);text-transform:uppercase;flex-wrap:wrap;gap:10px}
  .scroll{overflow-x:auto}
  @media(max-width:620px){td,th{padding:8px 6px;font-size:12px}h1{font-size:34px}}
</style></head>
<body><div class="wrap"><div class="card">
  <div class="top"><span>Live / settlements &mdash; on-chain, Base <span class="dot">&bull;</span></span>
    <span id="updated"></span></div>
  <h1 id="total">&mdash;</h1>
  <div class="sub">USDC settled to payout wallet</div>
  <div class="stats">
    <div class="stat"><b id="count">&mdash;</b><span>Payments</span></div>
    <div class="stat"><b id="balance">&mdash;</b><span>Wallet balance</span></div>
    <div class="stat"><b id="last">&mdash;</b><span>Last payment</span></div>
  </div>
  <div id="warnings"></div>
  <div class="scroll"><table><thead><tr>
    <th>Tool</th><th>Payer</th><th class="num">Amount</th><th>Tx</th><th class="num">Age</th>
  </tr></thead><tbody id="rows"></tbody></table></div>
  <div class="foot">
    <span>${toolCount} tools &middot; USDC on Base &middot; x402</span>
    <span><a href="https://basescan.org/address/${escapeHtml(snapshot.payTo)}" target="_blank"
       rel="noopener">Verify on Basescan &nearr;</a></span>
  </div>
</div></div>
<script>
const BOOT = ${JSON.stringify(snapshot)};
const fmt = n => (n === null || n === undefined)
  ? "\\u2014" : Number(n).toFixed(6).replace(/0+$/,"").replace(/\\.$/,"");
function age(ts){
  if(!ts) return "\\u2014";
  const s = Math.max(0,(Date.now()-Date.parse(ts))/1000);
  if(s<60) return Math.floor(s)+"s ago";
  if(s<3600) return Math.floor(s/60)+"m ago";
  if(s<86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
}
const esc = t => String(t).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const short = (h,n) => h ? esc(h.slice(0,n))+"\\u2026" : "\\u2014";
function render(d){
  document.getElementById("total").textContent = fmt(d.settledUsdc);
  document.getElementById("count").textContent = d.settledCount;
  document.getElementById("balance").textContent = d.balanceUsdc===null ? "\\u2014" : fmt(d.balanceUsdc);
  document.getElementById("last").textContent = age(d.lastSettledAt);
  document.getElementById("updated").textContent = "updated " + new Date().toLocaleTimeString();
  document.getElementById("warnings").innerHTML =
    (d.warnings||[]).map(w => '<div class="warn">'+esc(w)+"</div>").join("");
  const rows = (d.settlements||[]).map(s => {
    const label = s.tool ? esc(s.tool)
      : (s.toolCandidates && s.toolCandidates.length)
        ? '<span class="muted">'+s.toolCandidates.length+" tools @ "+fmt(s.amountUsdc)+"</span>"
        : '<span class="muted">unknown</span>';
    const tx = s.txHash
      ? '<a href="https://basescan.org/tx/'+esc(s.txHash)+'" target="_blank" rel="noopener">'
        + short(s.txHash,12)+"</a>"
      : "\\u2014";
    return "<tr><td>"+label+'</td><td class="muted">'+short(s.payer,10)+'</td><td class="num">'
      + fmt(s.amountUsdc)+' USDC</td><td>'+tx+'</td><td class="num muted">'+age(s.timestamp)+"</td></tr>";
  }).join("");
  document.getElementById("rows").innerHTML = rows ||
    '<tr><td colspan="5" class="empty">No settlements yet. An unpaid call returns 402; a paid one appears here within seconds.</td></tr>';
}
render(BOOT);
async function poll(){
  try{ const r = await fetch("/monitor.json",{cache:"no-store"}); if(r.ok) render(await r.json()); }
  catch(e){ /* transient: keep showing the last good snapshot */ }
}
setInterval(poll, 20000);
</script></body></html>`;
}
