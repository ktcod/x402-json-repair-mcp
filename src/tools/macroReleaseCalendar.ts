import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { fetchText, UpstreamError } from "../upstream/http.js";

export const TOOL_NAME = "macro_release_calendar";
export const TOOL_PRICE = "$0.01";

const SOURCE = "BLS";
/** BLS publishes its news-release schedule as a standard iCalendar feed. */
const ICS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const SOURCE_URL = "https://www.bls.gov/schedule/";

export interface ReleaseEvent {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** ISO timestamp when the feed supplies a time, else null (all-day entry). */
  datetime: string | null;
  title: string;
  source: string;
}

export interface CalendarResult {
  asOf: string;
  count: number;
  releases: ReleaseEvent[];
  source: string;
}

/** Unfold RFC 5545 continuation lines (a leading space or tab continues the previous line). */
export function unfoldIcs(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a DTSTART value into an ISO date plus an optional ISO timestamp. */
export function parseIcsDate(value: string): { date: string; datetime: string | null } | null {
  const v = value.trim();
  const dateOnly = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return { date: `${y}-${m}-${d}`, datetime: null };
  }
  const withTime = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (withTime) {
    const [, y, m, d, hh, mm, ss, z] = withTime;
    return {
      date: `${y}-${m}-${d}`,
      datetime: `${y}-${m}-${d}T${hh}:${mm}:${ss}${z ? "Z" : ""}`,
    };
  }
  return null;
}

/**
 * Parse an iCalendar feed into release events. Pure; no network.
 * `from` filters out anything before that ISO date, so callers get upcoming releases only.
 */
export function parseIcsReleases(
  ics: string,
  from: string,
  limit: number,
  filter?: string,
): ReleaseEvent[] {
  const lines = unfoldIcs(ics);
  const events: ReleaseEvent[] = [];
  let current: { date?: string; datetime?: string | null; title?: string } | null = null;

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      current = {};
      continue;
    }
    if (line.startsWith("END:VEVENT")) {
      if (current?.date && current.title) {
        events.push({
          date: current.date,
          datetime: current.datetime ?? null,
          title: current.title,
          source: SOURCE,
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const name = line.slice(0, sep).split(";")[0].toUpperCase();
    const value = line.slice(sep + 1);

    if (name === "DTSTART") {
      const parsed = parseIcsDate(value);
      if (parsed) {
        current.date = parsed.date;
        current.datetime = parsed.datetime;
      }
    } else if (name === "SUMMARY") {
      current.title = unescapeIcsText(value);
    }
  }

  if (events.length === 0) {
    throw new UpstreamError(SOURCE, "calendar feed contained no VEVENT entries");
  }

  const needle = filter?.trim().toLowerCase();
  return events
    .filter((e) => e.date >= from)
    .filter((e) => (needle ? e.title.toLowerCase().includes(needle) : true))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, limit);
}

export async function getReleaseCalendar(
  limit: number,
  filter?: string,
  now = new Date(),
): Promise<CalendarResult> {
  const ics = await fetchText(ICS_URL, { source: SOURCE, timeoutMs: 15_000 });
  const from = now.toISOString().slice(0, 10);
  const releases = parseIcsReleases(ics, from, limit, filter);
  return { asOf: from, count: releases.length, releases, source: SOURCE_URL };
}

const DESCRIPTION = `Upcoming U.S. economic data releases, with dates and times, from the official BLS news-release schedule.

Answers "what macro data drops next, and when" without scraping a web page. Covers the BLS release set that moves markets: CPI, PPI, the Employment Situation (nonfarm payrolls and unemployment), JOLTS, Employment Cost Index, real earnings and productivity.

When to use: planning around data risk, checking whether a print lands before a decision, or building a watchlist of upcoming events.

When NOT to use: you need the released VALUES (use bls_cpi for CPI), Fed/FOMC meeting dates, or non-U.S. statistical calendars.

Args:
  - limit (integer, optional, default 10): maximum releases to return (1-100), soonest first.
  - filter (string, optional): case-insensitive substring match on the release title, e.g. "CPI".

Returns structuredContent:
  {
    "asOf": "2026-08-14",
    "count": 1,
    "releases": [
      { "date": "2026-09-10", "datetime": "2026-09-10T12:30:00Z",
        "title": "Consumer Price Index", "source": "BLS" }
    ],
    "source": "https://www.bls.gov/schedule/"
  }

Only releases on or after today are returned, soonest first.`;

const inputSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Maximum number of upcoming releases to return, soonest first. Default 10."),
  filter: z
    .string()
    .optional()
    .describe('Optional case-insensitive substring filter on the title, e.g. "CPI".'),
};

export const macroReleaseCalendarTool: ToolModule = {
  name: TOOL_NAME,
  title: "US Economic Release Calendar",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max releases to return (1-100, default 10)." },
        filter: { type: "string", description: 'Substring filter on title, e.g. "CPI".' },
      },
    },
    inputExample: { limit: 10, filter: "CPI" },
    output: {
      example: {
        asOf: "2026-08-14",
        count: 1,
        releases: [
          {
            date: "2026-09-10",
            datetime: "2026-09-10T12:30:00Z",
            title: "Consumer Price Index",
            source: "BLS",
          },
        ],
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "US Economic Release Calendar",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ limit, filter }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed fetch.
        const result = await getReleaseCalendar(limit ?? 10, filter);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
