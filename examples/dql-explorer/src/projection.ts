/*
  Project KG entities onto the agent-chosen columns to build table rows.

  The agent returns dot-path columns (e.g. `location.city.name`). KG entities are
  nested objects that sometimes branch into arrays (e.g. `employments`,
  `industries`), so plucking a path can fan out to several values. We keep this
  forgiving: a bad or missing path yields an empty cell rather than an error, so
  one wrong column never blanks the whole table.
*/

import type { JsonObject } from "@diffbot/typescript";

/*
  Values longer than this are truncated so a stray long field can't wreck the
  table layout. Generous enough for names, URLs, short descriptions.
*/
const MAX_CELL_CHARS = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/*
  Walk `parts` into `node`, fanning out across any arrays encountered.

  Returns a flat list of leaf values (so `employments.employer.name` over an
  entity with several employments yields one entry per employer).
*/
function walk(node: unknown, parts: readonly string[]): unknown[] {
  if (parts.length === 0) {
    /*
      Expand a terminal array one level so an array of scalars/composites
      becomes several cells joined later, not a raw object-array dump.
    */
    return Array.isArray(node) ? node : [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap((item) => walk(item, parts));
  }
  if (isPlainObject(node)) {
    const [key, ...rest] = parts;
    if (key !== undefined && key in node) {
      return walk(node[key], rest);
    }
    return [];
  }
  return [];
}

/*
  Render a Diffbot date composite ({str, precision, timestamp}) as a date.

  Diffbot date strings carry a leading precision marker, e.g. `d2013-02-02`
  (day), `d2013-02` (month), `d2013` (year); the amount of date present already
  reflects the precision, so we just drop the marker. Falls back to the epoch-ms
  `timestamp` if no usable `str` is present.
*/
function formatDate(value: Record<string, unknown>): string | null {
  const raw = value.str;
  if (typeof raw === "string" && raw.length > 0) {
    if (raw.length > 1 && /[a-zA-Z]/.test(raw[0] ?? "") && /[\d-]/.test(raw[1] ?? "")) {
      return raw.slice(1);
    }
    return raw;
  }
  const ts = value.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }
  return null;
}

/* Render a single leaf value as a compact display string. */
function formatLeaf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (isPlainObject(value)) {
    /* Diffbot date composites carry `timestamp`/`precision` instead of a name. */
    if ("timestamp" in value || ("str" in value && "precision" in value)) {
      const formatted = formatDate(value);
      if (formatted !== null) return formatted;
    }
    /* Prefer a human label if the composite carries one. */
    for (const key of ["name", "label", "title"]) {
      const label = value[key];
      if (typeof label === "string" && label) return label;
      if (typeof label === "number") return String(label);
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/*
  Pluck a dot-path out of an entity and format it for a table cell.

  Multiple matches (from array fan-out) are de-duplicated, joined with `, `,
  and truncated. Missing paths return an empty string.
*/
export function pluck(entity: Record<string, unknown>, path: string): string {
  const leaves = walk(entity, path.split("."));
  const seen: string[] = [];
  for (const leaf of leaves) {
    const rendered = formatLeaf(leaf);
    if (rendered && !seen.includes(rendered)) {
      seen.push(rendered);
    }
  }
  let cell = seen.join(", ");
  if (cell.length > MAX_CELL_CHARS) {
    cell = `${cell.slice(0, MAX_CELL_CHARS - 1)}…`;
  }
  return cell;
}

/*
  Project each DQL hit onto `paths`, keyed by path.

  `data` is the `data` array from a DQL response. Each hit is
  `{score: ..., entity: {...}}`; older shapes embed the entity at the top
  level, so fall back to the hit itself (matches the KG retriever's behavior).
*/
export function buildRows(
  data: readonly JsonObject[],
  paths: readonly string[],
): Record<string, string>[] {
  return data.map((hit) => {
    const entity = isPlainObject(hit.entity) ? hit.entity : hit;
    const row: Record<string, string> = {};
    for (const path of paths) {
      row[path] = pluck(entity, path);
    }
    return row;
  });
}
