# Verification ledger

Every tool here was checked against live upstream data before it shipped — not just against unit
tests, because a test written from the same wrong assumption as the code passes happily.

That practice caught six real defects that documentation review alone would not have. They are
recorded below with the evidence that exposed each one. Several are traps in the sources
themselves, and at least one contradicts the publisher's own documentation, so any implementation
built by reading the docs is likely to have it.

Each fix is locked in by a regression test. Suite: 165 tests.

---

## 1. 13F holdings were 1000× too large — and SEC's own docs say to do it wrong

**The trap.** SEC documentation describes the `<value>` field in 13F information tables as
expressed *in thousands of dollars*. Following that instruction and multiplying by 1000 produces
values wrong by three orders of magnitude for modern filings.

**How it surfaced.** Reading Berkshire Hathaway's actual 13F and dividing value by share count:

```
AAPL  →  implied share price ≈ $289,000
```

No equity trades at $289,000/share. The multiplication was the error.

**The fix.** Treat `<value>` as whole USD. Locked in with real figures from the Ally Financial
position that exposed it:

```
value  = 577,211,815
shares =  12,561,737
implied price = $45.95   ✅ plausible
```

**Why it matters:** an agent computing portfolio weights or position sizes from an unverified 13F
implementation is off by 1000×, and nothing in the response looks wrong.

---

## 2. BEA monthly periods use a literal `M` separator

**The trap.** BEA's NIPA API returns monthly `TimePeriod` values as `2026M01`, mirroring the
quarterly `2026Q1` convention — not `202601` as the digits-only shape would suggest.

**How it surfaced.** `macro_pce` returned *"response contained no PCE observations"* with a valid,
working API key. The parsing regex silently matched nothing. Failing closed is why this was
visible at all — a lenient parser would have returned a confidently empty result.

**The fix.** Match `/^(\d{4})M(\d{2})$/` and normalize to `YYYY-MM`.

---

## 3. Census `resconst` silently returns five rows per month

**The trap.** Querying housing starts without a geography predicate returns five values for the
same month, with nothing in the returned columns to distinguish them.

**How it surfaced.** The four smaller values summed exactly to the largest:

```
177 + 751 + 295 + 162 = 1385
```

That is four Census regions plus the national total, interleaved. Picking "the" value for a month
would have silently returned one region's housing starts as if it were the US figure.

**The fix.** Require `for=us:1` to isolate the national total.

---

## 4. Census rejects `time` when it appears twice

**The trap.** Census's timeseries API errors with `unknown variable 'time'` when `time` is listed
in both the `get` parameter and as a predicate — even though the column is returned regardless.

**How it surfaced.** Affected both `macro_retail_sales` and `macro_housing`; confirmed by raw
`curl` that `time` comes back automatically when omitted from `get`.

**The fix.** Never request `time` in `get`.

---

## 5. Retail-sales year-over-year was permanently null

**The trap.** A design defect, not an upstream one. Prior-year data was fetched only inside a
`catch` block, so it ran only when the current-year request threw. But a mid-year fetch returns
enough points to succeed while still lacking the 12-months-prior observation needed for YoY.

**How it surfaced.** The call succeeded, the payload looked complete, and `yoyPercent` was `null`
every time.

**The fix.** Always fetch both years unconditionally. This is the failure mode this ledger exists
for: nothing errored, nothing looked broken, and the answer was quietly incomplete.

---

## 6. `NaN` passed a `typeof` guard

**The trap.** `typeof NaN === "number"`, so a `typeof o.val !== "number"` check admits `NaN`.

**How it surfaced.** A unit test on `edgarFinancials.selectPeriods`.

**The fix.** Guard with `Number.isFinite`.

---

## Payment safety: a failed call is never billed

The MCP SDK converts a thrown tool error into a **successful HTTP 200** carrying `isError: true`.
A payment gate that treats "the handler returned" as "the tool succeeded" will settle payment for
a result the caller never received.

Pure-compute tools rarely fail, so this path can sit unnoticed indefinitely. Network-backed tools
fail routinely — upstream 4xx/5xx, rate limits, timeouts.

The gate therefore inspects the tool's response body — JSON or SSE frames — for `isError: true`
or a JSON-RPC `error` **before** settling, and returns the error unsettled. Four regression tests
cover it: error via JSON, error via SSE, JSON-RPC error, and a guard that a successful call still
settles.

---

*Source: <https://github.com/ktcod/x402-json-repair-mcp>. Findings dated 2026-08-14.*
