/*
  Build the M&A / IPO dashboard: run two DQL queries, aggregate the entities.

  The Explorer tab lets an agent author one-off queries. This dashboard is the
  opposite shape: two *fixed* DQL templates (recent acquisitions, recent IPOs)
  parameterized by a minimum employee count and a date window, run against the KG,
  then reduced in TypeScript into chart-ready breakdowns (by industry, month,
  country, exchange) plus the underlying events. No model is involved — it's a
  deterministic roll-up of real KG data, so the numbers always trace back to the
  shown queries.

  These two queries are fetched with the SDK's `dql()` function directly rather
  than through `DiffbotKnowledgeGraphTool`: there is no LangChain Runnable in this
  path (no tracing to disable, unlike the Python port's `tracing_context(enabled
  =False)` — each call can return up to `MAX_FETCH` full entities, and there is
  nothing here worth tracing anyway), so going straight to the SDK is both
  simpler and sidesteps the need for a tracing escape hatch.
*/

import { dql, type DiffbotClient, type JsonObject } from "@diffbot/typescript";

/*
  Per-query fetch cap. Counts at the 4k-employee default are tiny (tens), but a
  user can drag the size limit to 0 and pull thousands; cap the sample so the
  roll-up stays fast. `totals.fetched` vs `hits` tells the UI when it's a sample.
*/
const MAX_FETCH = 400;

/* Default window: the trailing three months ending today. */
const DEFAULT_WINDOW_DAYS = 92;

/* Return [dateFrom, dateTo] ISO strings for the default 3-month window. */
export function defaultRange(): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - DEFAULT_WINDOW_DAYS);
  return [isoDate(from), isoDate(to)];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/*
  Pull a clean ISO-ish date string from a Diffbot DDate composite.

  DDate strings carry a leading precision marker (`d2026-03-02`, `d2026-03`,
  `d2026`); the marker is dropped, the already-present precision is kept.
*/
function ddateStr(ddate: unknown): string | null {
  if (!isPlainObject(ddate)) return null;
  const raw = ddate.str;
  if (typeof raw !== "string" || !raw) return null;
  if (raw.length > 1 && /[a-zA-Z]/.test(raw[0] ?? "") && /[\d-]/.test(raw[1] ?? "")) {
    return raw.slice(1);
  }
  return raw;
}

/* Best broad-industry label for an org: the lowest-level primary category. */
function primaryIndustry(entity: Record<string, unknown>): string {
  const cats = Array.isArray(entity.categories) ? entity.categories : [];
  const named = cats.filter(
    (c): c is Record<string, unknown> => isPlainObject(c) && typeof c.name === "string" && !!c.name,
  );
  if (named.length === 0) return "Uncategorized";
  const primary = named.filter((c) => c.isPrimary === true);
  const pool = primary.length > 0 ? primary : named;
  /* Level 1 is the broadest bucket (e.g. "Technology Companies"); prefer it. */
  pool.sort((a, b) => (typeof a.level === "number" ? a.level : 99) - (typeof b.level === "number" ? b.level : 99));
  const top = pool[0];
  return top && typeof top.name === "string" ? top.name : "Uncategorized";
}

/* Country name from the org's location composite, or 'Unknown'. */
function country(entity: Record<string, unknown>): string {
  const loc = entity.location;
  if (isPlainObject(loc)) {
    const c = loc.country;
    if (isPlainObject(c) && typeof c.name === "string" && c.name) return c.name;
  }
  return "Unknown";
}

/* Numeric value from a Diffbot Amount composite (currency ignored). */
function amountUsd(amount: unknown): number | null {
  if (isPlainObject(amount) && typeof amount.value === "number") return amount.value;
  return null;
}

/*
  Choose the acquisition that put the org in the window.

  An org's `acquiredBy` can list several deals across its history; the DQL
  matches if *any* falls in range. Prefer the latest deal whose date is inside
  [dateFrom, dateTo] (ISO strings compare correctly); fall back to the latest
  deal overall so a precision-trimmed date never blanks the event.
*/
function pickDeal(
  deals: unknown,
  dateFrom: string,
  dateTo: string,
): Record<string, unknown> {
  if (!Array.isArray(deals)) return {};
  const dated = deals.filter(isPlainObject);
  if (dated.length === 0) return {};
  const inWindow = dated.filter((d) => {
    const s = ddateStr(d.date);
    return s !== null && dateFrom <= s && s <= dateTo;
  });
  const pool = inWindow.length > 0 ? inWindow : dated;
  return pool.reduce((best, d) => ((ddateStr(d.date) ?? "") > (ddateStr(best.date) ?? "") ? d : best));
}

interface DealEvent {
  type: "M&A" | "IPO";
  name: string | null;
  date: string | null;
  industry: string;
  country: string;
  employees: number | null;
  amount_usd: number | null;
  exchange: string | null;
  counterparty: string | null;
}

/* Normalize an acquired org into one M&A event (its in-window acquisition). */
function maEvent(entity: Record<string, unknown>, dateFrom: string, dateTo: string): DealEvent {
  const deal = pickDeal(entity.acquiredBy, dateFrom, dateTo);
  return {
    type: "M&A",
    name: typeof entity.name === "string" ? entity.name : null,
    date: ddateStr(deal.date),
    industry: primaryIndustry(entity),
    country: country(entity),
    employees: typeof entity.nbEmployees === "number" ? entity.nbEmployees : null,
    amount_usd: amountUsd(deal.amount),
    exchange: null,
    counterparty: typeof deal.name === "string" ? deal.name : null, // acquirer
  };
}

/* Normalize a newly-public org into one IPO event. */
function ipoEvent(entity: Record<string, unknown>): DealEvent {
  const ipo = isPlainObject(entity.ipo) ? entity.ipo : {};
  return {
    type: "IPO",
    name: typeof entity.name === "string" ? entity.name : null,
    date: ddateStr(ipo.date),
    industry: primaryIndustry(entity),
    country: country(entity),
    employees: typeof entity.nbEmployees === "number" ? entity.nbEmployees : null,
    amount_usd: null,
    exchange: typeof ipo.stockExchange === "string" ? ipo.stockExchange : null,
    counterparty: null,
  };
}

/* Pull entity objects out of a DQL response (`data: [{entity: {...}}]`). */
function entitiesOf(body: JsonObject): Record<string, unknown>[] {
  const data = Array.isArray(body.data) ? body.data : [];
  return data.map((hit) => (isPlainObject(hit) && isPlainObject(hit.entity) ? hit.entity : (hit as Record<string, unknown>)));
}

interface BreakdownRow {
  [key: string]: string | number;
  "M&A": number;
  IPO: number;
  total: number;
}

/* Group events by `event[key]`, counting per type and total, sorted desc. */
function countBreakdown(events: readonly DealEvent[], key: "industry" | "country" | "exchange"): BreakdownRow[] {
  const buckets = new Map<string, { "M&A": number; IPO: number }>();
  for (const ev of events) {
    const label = (ev[key] as string | null) ?? "Unknown";
    const counts = buckets.get(label) ?? { "M&A": 0, IPO: 0 };
    counts[ev.type] += 1;
    buckets.set(label, counts);
  }
  const rows: BreakdownRow[] = Array.from(buckets.entries()).map(([label, counts]) => ({
    [key]: label,
    "M&A": counts["M&A"],
    IPO: counts.IPO,
    total: counts["M&A"] + counts.IPO,
  }));
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

interface MonthRow {
  month: string;
  ma: number;
  ipo: number;
  total: number;
}

/* Count M&A/IPO per calendar month (YYYY-MM), chronological. */
function monthSeries(events: readonly DealEvent[]): MonthRow[] {
  const buckets = new Map<string, { "M&A": number; IPO: number }>();
  for (const ev of events) {
    const month = ev.date && ev.date.length >= 7 ? ev.date.slice(0, 7) : "unknown";
    const counts = buckets.get(month) ?? { "M&A": 0, IPO: 0 };
    counts[ev.type] += 1;
    buckets.set(month, counts);
  }
  const rows: MonthRow[] = Array.from(buckets.entries()).map(([month, counts]) => ({
    month,
    ma: counts["M&A"],
    ipo: counts.IPO,
    total: counts["M&A"] + counts.IPO,
  }));
  rows.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  return rows;
}

async function build(
  client: DiffbotClient,
  minEmployees: number,
  dateFrom: string,
  dateTo: string,
): Promise<Record<string, unknown>> {
  /* Omit the headcount clause entirely at 0 — DQL has no "any value" wildcard. */
  const emp = minEmployees > 0 ? ` nbEmployees>${minEmployees}` : "";
  const maQuery =
    `type:Organization isAcquired:true acquiredBy.date>="${dateFrom}" ` +
    `acquiredBy.date<="${dateTo}"${emp}`;
  const ipoQuery = `type:Organization ipo.date>="${dateFrom}" ipo.date<="${dateTo}"${emp}`;

  const [maBody, ipoBody] = await Promise.all([
    dql(client, maQuery, { size: MAX_FETCH }),
    dql(client, ipoQuery, { size: MAX_FETCH }),
  ]);
  if (maBody instanceof Uint8Array || ipoBody instanceof Uint8Array) {
    throw new TypeError("Unexpected non-JSON DQL response.");
  }

  const maEntities = entitiesOf(maBody);
  const ipoEntities = entitiesOf(ipoBody);
  const events: DealEvent[] = [
    ...maEntities.map((e) => maEvent(e, dateFrom, dateTo)),
    ...ipoEntities.map((e) => ipoEvent(e)),
  ];
  /* Most recent first for the events table / top-deals list. */
  events.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const maHits = typeof maBody.hits === "number" ? maBody.hits : 0;
  const ipoHits = typeof ipoBody.hits === "number" ? ipoBody.hits : 0;
  const dealValue = events.reduce((sum, e) => sum + (e.amount_usd ?? 0), 0);

  const topDeals = events
    .filter((e) => e.type === "M&A" && e.amount_usd != null)
    .sort((a, b) => (b.amount_usd ?? 0) - (a.amount_usd ?? 0))
    .slice(0, 8);

  return {
    min_employees: minEmployees,
    date_from: dateFrom,
    date_to: dateTo,
    totals: {
      events: events.length,
      ma: maHits,
      ipo: ipoHits,
      deal_value_usd: dealValue,
      fetched: events.length,
      is_sample: maHits > maEntities.length || ipoHits > ipoEntities.length,
    },
    by_industry: countBreakdown(events, "industry").slice(0, 12),
    by_month: monthSeries(events),
    by_country: countBreakdown(events, "country").slice(0, 10),
    by_exchange: countBreakdown(
      events.filter((e) => e.type === "IPO"),
      "exchange",
    ).slice(0, 10),
    top_deals: topDeals,
    events,
    queries: { ma: maQuery, ipo: ipoQuery },
    error: null,
  };
}

/*
  Build the dashboard payload, surfacing any failure as an `error` field.

  `client` is shared with the rest of the app — the two KG queries reuse its
  connection pool rather than opening a new one.
*/
export async function buildDashboard(
  client: DiffbotClient,
  minEmployees: number,
  dateFrom: string,
  dateTo: string,
): Promise<Record<string, unknown>> {
  try {
    return await build(client, minEmployees, dateFrom, dateTo);
  } catch (exc) {
    return {
      min_employees: minEmployees,
      date_from: dateFrom,
      date_to: dateTo,
      totals: {
        events: 0,
        ma: 0,
        ipo: 0,
        deal_value_usd: 0,
        fetched: 0,
        is_sample: false,
      },
      by_industry: [],
      by_month: [],
      by_country: [],
      by_exchange: [],
      top_deals: [],
      events: [],
      queries: {},
      error: `Failed to build the dashboard: ${exc instanceof Error ? exc.message : String(exc)}`,
    };
  }
}
