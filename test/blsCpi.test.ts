import { describe, it, expect } from "vitest";
import { computeCpi, type BlsResponse } from "../src/tools/blsCpi.js";
import { UpstreamError } from "../src/upstream/http.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Build a BLS-shaped series. `values` is oldest-first starting at 2025-01. */
function series(seriesID: string, values: number[]) {
  const data = values.map((value, i) => {
    const monthIndex = i % 12;
    const year = 2025 + Math.floor(i / 12);
    return {
      year: String(year),
      period: `M${String(monthIndex + 1).padStart(2, "0")}`,
      periodName: MONTHS[monthIndex],
      value: value.toFixed(3),
    };
  });
  // BLS returns newest-first; reverse so the fixture matches the real API ordering.
  return { seriesID, data: data.reverse() };
}

/** 13 monthly points: 2025-01..2026-01, so a year-over-year comparison exists. */
const THIRTEEN = [100, 100.2, 100.4, 100.6, 100.8, 101, 101.2, 101.4, 101.6, 101.8, 102, 102.2, 103];

function response(): BlsResponse {
  return {
    status: "REQUEST_SUCCEEDED",
    Results: {
      series: [
        series("CUUR0000SA0", THIRTEEN),
        series("CUUR0000SA0L1E", THIRTEEN.map((v) => v + 5)),
        series("CUSR0000SA0", [100, 100.5, 101, 101.5, 102, 102.5, 103, 103.5, 104, 104.5, 105, 105.5, 106]),
        series("CUSR0000SA0L1E", [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212]),
      ],
    },
  };
}

describe("computeCpi", () => {
  it("reports the latest month and index level", () => {
    const r = computeCpi(response());
    expect(r.asOf).toBe("2026-01");
    expect(r.periodName).toBe("January 2026");
    expect(r.headline.index).toBe(103);
  });

  it("computes year-over-year from the NSA series", () => {
    // 2026-01 = 103 vs 2025-01 = 100 -> +3.0%
    expect(computeCpi(response()).headline.yoyPercent).toBe(3);
  });

  it("computes month-over-month from the seasonally adjusted series", () => {
    // SA 2026-01 = 106 vs 2025-12 = 105.5 -> +0.47% -> rounds to 0.5
    expect(computeCpi(response()).headline.momPercent).toBe(0.5);
  });

  it("computes core separately from headline", () => {
    const r = computeCpi(response());
    expect(r.core.index).toBe(108);
    // 108 vs 105 -> +2.857% -> rounds to 2.9
    expect(r.core.yoyPercent).toBe(2.9);
  });

  it("ignores M13 annual-average rows", () => {
    const body = response();
    body.Results!.series![0].data!.unshift({
      year: "2026",
      period: "M13",
      periodName: "Annual",
      value: "999.000",
    });
    const r = computeCpi(body);
    expect(r.asOf).toBe("2026-01");
    expect(r.headline.index).toBe(103);
  });

  it("returns null rates when there is no year-ago observation", () => {
    const r = computeCpi({
      status: "REQUEST_SUCCEEDED",
      Results: { series: [series("CUUR0000SA0", [100, 101])] },
    });
    expect(r.headline.index).toBe(101);
    expect(r.headline.yoyPercent).toBeNull();
    expect(r.headline.momPercent).toBeNull();
  });

  it("throws UpstreamError when BLS reports a failure status", () => {
    expect(() =>
      computeCpi({ status: "REQUEST_NOT_PROCESSED", message: ["daily threshold reached"] }),
    ).toThrow(UpstreamError);
  });

  it("throws UpstreamError when no monthly observations are present", () => {
    expect(() => computeCpi({ status: "REQUEST_SUCCEEDED", Results: { series: [] } })).toThrow(
      UpstreamError,
    );
  });
});
