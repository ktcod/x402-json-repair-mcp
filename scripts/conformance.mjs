#!/usr/bin/env node
/**
 * Conformance runner for agent-facing US financial data.
 *
 * Points the checks in src/conformance/checks.ts at a LIVE x402 provider — ours or anyone's — and
 * reports what it finds. Every check detects a defect from its shape alone (impossible values,
 * internal inconsistency), so no known-good answer is needed and no provider is privileged.
 *
 * Providers describe themselves differently, so each needs a small ADAPTER saying which endpoint
 * answers which question and where the fields live. The AgentFund adapter below is the worked
 * example; add others alongside it.
 *
 * Requires a build first (`npm run build`) — it imports the compiled checks.
 *
 * Usage:
 *   node scripts/conformance.mjs                             # plan: what it calls, and the cost
 *   PAYER_PRIVATE_KEY=0x… node scripts/conformance.mjs --run
 *   PAYER_PRIVATE_KEY=0x… node scripts/conformance.mjs --run --base https://other.example
 *
 * Exits non-zero if any check fails, so CI can gate on it.
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import {
  checkHoldingsValueScale,
  checkSeriesNotEmpty,
  checkNationalMagnitude,
  checkFiniteNumbers,
  checkDerivedCompleteness,
  checkUnitsDeclared,
  checkFreshness,
  checkDecimalsAdjusted,
  summarize,
} from "../dist/conformance/checks.js";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valueOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = valueOf("--base", "https://x402.agentfund.net").replace(/\/$/, "");

/**
 * One probe = one paid call plus the checks that apply to its response.
 *
 * Ranges are deliberately wide: they catch an order-of-magnitude or wrong-row error, not a
 * forecast miss. Lags come from each publisher's actual release cadence.
 */
const AGENTFUND_ADAPTER = [
  {
    tool: "edgar_13f_holdings",
    body: { ticker: "1067983", limit: 10 }, // Berkshire Hathaway
    checks: (r) => [
      checkHoldingsValueScale(r.holdings ?? []),
      checkSeriesNotEmpty((r.holdings ?? []).length, "13F holdings"),
      checkFiniteNumbers(r, "13F"),
      checkUnitsDeclared(r),
      // 13F is due 45 days after quarter end, so a filing can legitimately be ~5 months old.
      checkFreshness(r.periodOfReport, 200, "13F period"),
    ],
  },
  {
    tool: "macro_housing",
    body: {},
    checks: (r) => [
      checkNationalMagnitude(r.startsThousands, "housing starts", { min: 500, max: 3000 }),
      checkNationalMagnitude(r.permitsThousands, "building permits", { min: 500, max: 3000 }),
      checkFiniteNumbers(r, "housing"),
      checkUnitsDeclared(r),
      checkFreshness(r.asOf, 120, "housing"),
    ],
  },
  {
    tool: "macro_retail_sales",
    body: {},
    checks: (r) => [
      checkNationalMagnitude(r.salesMillions, "retail sales", { min: 200_000, max: 1_500_000 }),
      // Mid-year a full year of history exists, so YoY must be computable.
      checkDerivedCompleteness(r.yoyPercent, true, "retail yoyPercent"),
      checkFiniteNumbers(r, "retail"),
      checkUnitsDeclared(r),
      checkFreshness(r.asOf, 120, "retail"),
    ],
  },
  {
    tool: "macro_pce",
    body: {},
    checks: (r) => [
      checkSeriesNotEmpty(r?.headline?.index ? 1 : 0, "PCE headline"),
      checkSeriesNotEmpty(r?.core?.index ? 1 : 0, "PCE core"),
      checkFiniteNumbers(r, "PCE"),
      checkUnitsDeclared(r),
      checkFreshness(r.asOf, 120, "PCE"),
    ],
  },
  {
    tool: "onchain_portfolio",
    body: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    checks: (r) => {
      const out = [checkFiniteNumbers(r, "portfolio"), checkUnitsDeclared(r)];
      for (const a of r.assets ?? []) {
        out.push(checkDecimalsAdjusted(a.balance, a.decimals, a.symbol ?? "asset"));
      }
      return out;
    },
  },
];

const openapi = await (await fetch(`${BASE}/openapi.json`)).json();
const priceOf = (tool) =>
  Number(openapi.paths?.[`/x402/${tool}`]?.post?.["x-payment-info"]?.price?.amount ?? 0);

const probes = AGENTFUND_ADAPTER.filter((p) => openapi.paths?.[`/x402/${p.tool}`]);
const missing = AGENTFUND_ADAPTER.filter((p) => !openapi.paths?.[`/x402/${p.tool}`]);
const cost = probes.reduce((s, p) => s + priceOf(p.tool), 0);

console.error(`Provider: ${BASE}`);
console.error(`Probes:   ${probes.length} of ${AGENTFUND_ADAPTER.length} available`);
for (const m of missing) console.error(`  [absent] ${m.tool}`);
for (const p of probes) {
  console.error(`  [ call ] ${p.tool.padEnd(24)} $${priceOf(p.tool).toFixed(3)}`);
}
console.error(`Cost:     $${cost.toFixed(3)}\n`);

if (!flag("--run")) {
  console.error("Plan only. Re-run with --run (and PAYER_PRIVATE_KEY set) to execute.");
  process.exit(0);
}

const pk = process.env.PAYER_PRIVATE_KEY;
if (!pk) {
  console.error("ERROR: --run needs PAYER_PRIVATE_KEY=0x... (a Base wallet holding USDC).");
  process.exit(1);
}
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const pay = wrapFetchWithPayment(fetch, client);

const findings = [];
for (const probe of probes) {
  console.error(probe.tool);
  let result;
  try {
    const res = await pay(`${BASE}/x402/${probe.tool}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(probe.body),
    });
    if (res.status !== 200) {
      findings.push({
        checkId: "purchasable",
        status: "fail",
        detail: `${probe.tool}: HTTP ${res.status} — could not be purchased`,
      });
      console.error(`  purchasable          FAIL  HTTP ${res.status}\n`);
      continue;
    }
    result = await res.json();
  } catch (e) {
    findings.push({
      checkId: "purchasable",
      status: "fail",
      detail: `${probe.tool}: ${e instanceof Error ? e.message : String(e)}`,
    });
    console.error(`  purchasable          FAIL  ${String(e).slice(0, 70)}\n`);
    continue;
  }

  for (const f of probe.checks(result)) {
    findings.push(f);
    const mark = f.status === "pass" ? "pass" : f.status === "fail" ? "FAIL" : "skip";
    console.error(`  ${f.checkId.padEnd(20)} ${mark}  ${f.detail.slice(0, 90)}`);
  }
  console.error("");
}

const s = summarize(findings);
console.error(`${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`);
if (!s.ok) {
  console.error("\nFailures are defects in the DATA, not the transport — see VERIFICATION.md.");
}

// Publish the result. A conformance claim nobody can inspect is just an assertion, so the run is
// written to CONFORMANCE.md, embedded into the bundle by `npm run gen:docs`, and served at
// /CONFORMANCE.md. The date is stamped from the actual run, never hand-edited.
const stamp = new Date().toISOString().slice(0, 10);
const rows = findings
  .map((f) => {
    const mark = f.status === "pass" ? "pass" : f.status === "fail" ? "**FAIL**" : "skip";
    return `| \`${f.checkId}\` | ${mark} | ${f.detail.replace(/\|/g, "\\|")} |`;
  })
  .join("\n");

const md = `# Conformance results

Last run: **${stamp}** against \`${BASE}\`

**${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped.**

These are live results from paid calls against the production endpoints — not a self-test against
fixtures. Reproduce them with \`npm run conformance -- --run\`, or point the suite at any other
x402 provider with \`--base\`.

What the checks catch, and why they can run against a provider we did not build, is described in
[VERIFICATION.md](VERIFICATION.md). A \`skip\` means the check could not be judged fairly on this
response — it is never a quiet failure.

| Check | Result | Detail |
| --- | --- | --- |
${rows}

---

*Generated by \`scripts/conformance.mjs\`. This file is overwritten on each run; do not edit it by
hand.*
`;

const { writeFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { dirname, join } = await import("node:path");
const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "CONFORMANCE.md");
writeFileSync(outPath, md);
console.error(`\nwrote ${outPath} — run \`npm run gen:docs\` to publish it.`);

process.exit(s.ok ? 0 : 1);
