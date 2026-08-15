/**
 * Conformance checks for agent-facing US financial data.
 *
 * Each check encodes a real defect found by verifying a tool against live upstream data — see
 * VERIFICATION.md. They are written to run against ANY provider, including ones we did not build,
 * which rules out comparing against a known-good answer.
 *
 * The trick that makes that possible: every one of these bugs produces a value that is either
 * physically impossible or internally inconsistent. A 13F position priced at $289,000/share, a
 * national housing figure the size of one census region, a "successful" response with no
 * observations in it — none of those need ground truth to detect.
 *
 * That also bounds what this suite can claim. It proves a number is NOT obviously broken; it does
 * not prove the number is right. Checks therefore fail loudly and pass quietly, and anything
 * genuinely ambiguous returns `skip` rather than a false accusation.
 */

export type Status = "pass" | "fail" | "skip";

export interface Finding {
  checkId: string;
  status: Status;
  /** One line, specific enough to act on. */
  detail: string;
}

const pass = (checkId: string, detail: string): Finding => ({ checkId, status: "pass", detail });
const fail = (checkId: string, detail: string): Finding => ({ checkId, status: "fail", detail });
const skip = (checkId: string, detail: string): Finding => ({ checkId, status: "skip", detail });

/** Static description of every check, so the suite can document itself. */
export interface CheckSpec {
  id: string;
  title: string;
  /** The real-world defect this catches. */
  catches: string;
}

export const CHECK_SPECS: CheckSpec[] = [
  {
    id: "holdings-value-scale",
    title: "13F values are whole USD, not thousands",
    catches:
      "SEC documentation describes the 13F <value> field as thousands of dollars. For modern " +
      "filings it is already whole dollars, so following the documentation inflates every " +
      "position by 1000x. Detected via implied price per share.",
  },
  {
    id: "series-not-empty",
    title: "A published series returns observations",
    catches:
      "Date-format and query-parameter mistakes (BEA's literal 'M' month separator, Census " +
      "rejecting a duplicated `time` parameter) yield an HTTP 200 with zero rows. The call looks " +
      "successful and the answer is silently absent.",
  },
  {
    id: "national-not-regional",
    title: "National aggregates are national",
    catches:
      "Census `resconst` returns one row per census region plus the US total, with nothing in " +
      "the response to tell them apart. Picking the wrong row reports a single region as the " +
      "national figure — roughly a quarter of the true value.",
  },
  {
    id: "finite-numbers",
    title: "Numeric fields are finite",
    catches:
      "`typeof NaN === 'number'`, so a typeof guard admits NaN. It then serialises to null or " +
      "propagates through arithmetic, and downstream maths silently produces nonsense.",
  },
  {
    id: "derived-completeness",
    title: "Derived figures are present when the inputs allow them",
    catches:
      "Year-over-year needs an observation 12 months prior. Fetching only the current year " +
      "succeeds mid-year while lacking that point, so the field stays null forever and the " +
      "response still looks complete.",
  },
  {
    id: "units-declared",
    title: "Values carry their units and as-of date",
    catches:
      "A bare number is unusable by an agent that cannot tell percent from basis points, " +
      "millions from billions, or a stale print from a fresh one.",
  },
  {
    id: "freshness",
    title: "Data is within its publication lag",
    catches:
      "Government statistics are periodic and revised. A response with no as-of date, or one far " +
      "outside the expected release cadence, is stale data presented as current.",
  },
  {
    id: "decimals-adjusted",
    title: "Token balances are decimal-adjusted",
    catches:
      "Returning raw base units for an 18-decimal token overstates a balance by 10^18. The value " +
      "is self-consistent and catastrophically wrong.",
  },
];

/**
 * 13F holdings: implied price per share must be plausible for a listed equity.
 *
 * The 1000x bug puts implied prices in the hundreds of thousands. Berkshire class-A shares
 * genuinely trade near $700k, so one expensive position proves nothing — we fail only when the
 * MAJORITY of positions are implausible, which is the signature of a scaling error rather than
 * one unusual holding.
 */
export function checkHoldingsValueScale(
  holdings: Array<{ issuer?: string; valueUsd?: number; shares?: number }>,
): Finding {
  const id = "holdings-value-scale";
  const priced = holdings
    .filter((h) => Number.isFinite(h.valueUsd) && Number.isFinite(h.shares) && (h.shares ?? 0) > 0)
    .map((h) => ({
      issuer: h.issuer ?? "?",
      price: (h.valueUsd as number) / (h.shares as number),
    }));

  if (priced.length < 3) return skip(id, "fewer than 3 priced positions; not enough to judge");

  const IMPLAUSIBLE = 10_000; // USD/share; above this is rare for any listed equity
  const bad = priced.filter((p) => p.price > IMPLAUSIBLE);
  if (bad.length > priced.length / 2) {
    const worst = bad.sort((a, b) => b.price - a.price)[0];
    return fail(
      id,
      `${bad.length}/${priced.length} positions imply >$${IMPLAUSIBLE.toLocaleString()}/share ` +
        `(worst: ${worst.issuer} at $${Math.round(worst.price).toLocaleString()}/share) — ` +
        `consistent with values being multiplied by 1000`,
    );
  }
  return pass(id, `${priced.length} positions, implied prices plausible`);
}

/** A series published on a known cadence must come back with observations. */
export function checkSeriesNotEmpty(observationCount: number, label: string): Finding {
  const id = "series-not-empty";
  return observationCount > 0
    ? pass(id, `${label}: ${observationCount} observation(s)`)
    : fail(id, `${label}: zero observations returned despite a successful response`);
}

/**
 * A national aggregate must be in the national range, not a regional slice.
 *
 * Bounds are deliberately wide — this catches an order-of-magnitude or wrong-row error, not a
 * forecast miss. A genuinely unavailable value skips rather than fails.
 */
export function checkNationalMagnitude(
  value: number | null | undefined,
  label: string,
  range: { min: number; max: number },
): Finding {
  const id = "national-not-regional";
  if (value === null || value === undefined) return skip(id, `${label}: not reported`);
  if (!Number.isFinite(value)) return fail(id, `${label}: not a finite number (${String(value)})`);
  if (value < range.min || value > range.max) {
    return fail(
      id,
      `${label}: ${value} is outside the plausible national range ${range.min}-${range.max} — ` +
        `often a regional row reported as the national total`,
    );
  }
  return pass(id, `${label}: ${value} within the national range`);
}

/** Walk a response and reject NaN/Infinity anywhere in it. */
export function checkFiniteNumbers(value: unknown, label: string): Finding {
  const id = "finite-numbers";
  const offenders: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) offenders.push(`${path || "(root)"}=${String(v)}`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) walk(item, path ? `${path}.${k}` : k);
    }
  };
  walk(value, "");
  return offenders.length
    ? fail(id, `${label}: non-finite number(s) at ${offenders.slice(0, 5).join(", ")}`)
    : pass(id, `${label}: all numeric fields finite`);
}

/**
 * A derived field must be present when its inputs were available.
 *
 * `inputsAvailable` is the caller's assertion that the history needed to compute it was in range;
 * without that we cannot distinguish "not computable yet" from "quietly dropped".
 */
export function checkDerivedCompleteness(
  derived: number | null | undefined,
  inputsAvailable: boolean,
  label: string,
): Finding {
  const id = "derived-completeness";
  if (!inputsAvailable) return skip(id, `${label}: inputs not in range, cannot be computed`);
  return derived === null || derived === undefined
    ? fail(id, `${label}: null even though the inputs to compute it were available`)
    : pass(id, `${label}: present (${derived})`);
}

/** Every numeric answer needs an as-of date and a stated unit somewhere in the payload. */
export function checkUnitsDeclared(
  payload: Record<string, unknown>,
  opts: { asOfKeys?: string[]; unitHints?: string[] } = {},
): Finding {
  const id = "units-declared";
  const asOfKeys = opts.asOfKeys ?? ["asof", "date", "period", "timestamp", "periodofreport"];
  const unitHints = opts.unitHints ?? [
    "percent",
    "usd",
    "thousand",
    "million",
    "billion",
    "bbl",
    "bcf",
    "gwei",
    "index",
    "units",
    "decimals",
  ];
  const flat = JSON.stringify(payload).toLowerCase();
  const topLevel = new Set(Object.keys(payload).map((k) => k.toLowerCase()));

  const hasAsOf = asOfKeys.some((k) => topLevel.has(k));
  const hasUnit = unitHints.some((u) => flat.includes(u));

  if (!hasAsOf && !hasUnit) return fail(id, "no as-of date and no unit anywhere in the payload");
  if (!hasAsOf) return fail(id, "units present but no as-of date — cannot tell fresh from stale");
  if (!hasUnit) return fail(id, "as-of date present but no unit stated — the number is ambiguous");
  return pass(id, "as-of date and units both present");
}

/** As-of date must fall within the expected publication lag for the series. */
export function checkFreshness(
  asOf: string | null | undefined,
  maxLagDays: number,
  label: string,
  now = new Date(),
): Finding {
  const id = "freshness";
  if (!asOf) return fail(id, `${label}: no as-of date reported`);
  // "2026-06" is a month, not a day; normalise so Date.parse does not reject it.
  const parsed = Date.parse(/^\d{4}-\d{2}$/.test(asOf) ? `${asOf}-01` : asOf);
  if (Number.isNaN(parsed)) return fail(id, `${label}: unparseable as-of date "${asOf}"`);
  const lagDays = Math.floor((now.getTime() - parsed) / 86_400_000);
  if (lagDays < 0) return fail(id, `${label}: as-of date ${asOf} is in the future`);
  return lagDays <= maxLagDays
    ? pass(id, `${label}: ${asOf} (${lagDays}d old, limit ${maxLagDays}d)`)
    : fail(id, `${label}: ${asOf} is ${lagDays}d old, beyond the ${maxLagDays}d publication lag`);
}

/**
 * Token balances must be decimal-adjusted.
 *
 * A raw 18-decimal balance is ~10^18 times too large. We flag values that are implausibly huge
 * AND look like a base-unit figure, rather than any large number, so a genuine whale is not
 * accused of a bug.
 */
export function checkDecimalsAdjusted(
  balance: number | string | null | undefined,
  decimals: number | null | undefined,
  label: string,
): Finding {
  const id = "decimals-adjusted";
  if (balance === null || balance === undefined) return skip(id, `${label}: no balance reported`);
  const n = typeof balance === "string" ? Number(balance) : balance;
  if (!Number.isFinite(n)) return fail(id, `${label}: balance is not a finite number`);
  if (decimals === null || decimals === undefined) {
    return fail(id, `${label}: no decimals reported, so the scale of ${n} is unknowable`);
  }
  // 10^decimals is the raw-unit boundary: a decimal-adjusted balance at or above it would be an
  // absurd holding for any real token, while a raw value lands there almost by definition.
  const rawThreshold = 10 ** decimals;
  return n >= rawThreshold
    ? fail(
        id,
        `${label}: ${n} is at or above 10^${decimals} — looks like raw base units, not adjusted`,
      )
    : pass(id, `${label}: ${n} consistent with ${decimals} decimals`);
}

/** Roll findings into a single verdict. */
export function summarize(findings: Finding[]): {
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
} {
  const passed = findings.filter((f) => f.status === "pass").length;
  const failed = findings.filter((f) => f.status === "fail").length;
  const skipped = findings.filter((f) => f.status === "skip").length;
  return { passed, failed, skipped, ok: failed === 0 };
}
