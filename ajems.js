// ajems.js — the ONLY module that talks to AJEMS.
//
// Every function takes `ctx` = { tenant, baseUrl, secretKey }, resolved from
// the caller's session. Nothing here ever reads a tenant from a tool argument.
//
// Shapes this is built against (json-builder-api-guide):
//   workspace_config/ -> { tenant, apps:[{ app_id, title, forms:[{ form_id, title,
//                          jsonBuilderUrls:{ detail_get, response_list_get, response_post } }] }] }
//   form detail       -> { fields:[{ field_type, label, key, options }], labels:{ key: label } }
//   response list     -> { responses:[{ _id, created_at, response:{ key: value } }], labels, count }

import { cached, invalidate, tenantNamespace, withLimit } from "./cache.js";

const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 20000);
const CONFIG_TTL = Number(process.env.CONFIG_CACHE_MS || 60000);
const ROWS_TTL = Number(process.env.ROWS_CACHE_MS || 20000);

// Ceiling on rows held in memory for one form. Exists to protect the server,
// not to limit answers: counts and totals are computed over everything below it.
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || 50000);

// Above this, skip the cache. Holding very large row sets for every tenant is
// what would actually exhaust memory.
const CACHE_MAX_ROWS = Number(process.env.CACHE_MAX_ROWS || 20000);

// ---------------------------------------------------------------------------
// Single request path
// ---------------------------------------------------------------------------

async function call(ctx, urlOrPath, { method = "GET", body } = {}) {
  const url = urlOrPath.startsWith("http")
    ? urlOrPath
    : `${ctx.baseUrl.replace(/\/$/, "")}/${urlOrPath.replace(/^\//, "")}`;

  const res = await withLimit(() =>
    fetch(url, {
      method,
      headers: {
        "X-Json-Builder-Secret-Key": ctx.secretKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      // Without this, one hung request holds a concurrency slot forever.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  ).catch((e) => {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error(`AJEMS did not respond within ${TIMEOUT_MS / 1000}s (${url})`);
    }
    throw e;
  });

  const text = await res.text();

  if (!res.ok) throw new Error(`AJEMS ${res.status} on ${url}: ${text.slice(0, 300)}`);

  // A workspace's frontend returns index.html with a 200 for every path, which
  // is otherwise a very confusing failure.
  if (text.trimStart().startsWith("<")) {
    throw new Error(`Got HTML instead of JSON from ${url}. The base URL is probably the frontend, not the API.`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const nsConfig = (ctx) => `${tenantNamespace(ctx)}:config`;
const nsRows = (ctx, formId) => `${tenantNamespace(ctx)}:rows:${formId}`;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function getWorkspaceConfig(ctx) {
  return cached(nsConfig(ctx), CONFIG_TTL, () => call(ctx, "workspace_config/"));
}

/** Flatten workspace_config into a flat list of forms with their endpoints. */
export function flattenForms(config) {
  const forms = [];
  for (const app of config?.apps || []) {
    for (const form of app.forms || []) {
      const urls = form.jsonBuilderUrls || {};
      forms.push({
        app: app.title || "App",
        app_id: app.app_id ?? null,
        form_id: String(form.form_id ?? ""),
        form_name: form.title || "Form",
        detail_url: urls.detail_get?.url || null,
        list_url: urls.response_list_get?.url || null,
        post_url: urls.response_post?.url || urls.response_list_get?.url || null,
        post_allowed: form.isThirdPartyPostAllowed ?? null,
      });
    }
  }
  return forms;
}

/**
 * Build a form handle from the documented URL pattern. Used when a form is too
 * new to appear in workspace_config yet.
 */
async function lookupFormById(ctx, formId) {
  const base = ctx.baseUrl.replace(/\/$/, "");
  try {
    const detail = await call(ctx, `forms/${encodeURIComponent(formId)}/`);
    if (!detail?.form_id) return null;
    return {
      app: detail.app_title || "App",
      app_id: detail.app_id ?? null,
      form_id: String(detail.form_id),
      form_name: detail.title || "Form",
      detail_url: `${base}/forms/${detail.form_id}/`,
      list_url: `${base}/forms/${detail.form_id}/responses/`,
      post_url: `${base}/forms/${detail.form_id}/responses/`,
      post_allowed: detail.isThirdPartyPostAllowed ?? null,
    };
  } catch {
    return null;
  }
}

/** Resolve a form by id, exact name, or partial name. */
export async function findForm(ctx, formIdOrName) {
  const forms = flattenForms(await getWorkspaceConfig(ctx));
  const needle = String(formIdOrName).toLowerCase().trim();

  const match =
    forms.find((f) => f.form_id.toLowerCase() === needle) ||
    forms.find((f) => f.form_name.toLowerCase() === needle) ||
    forms.find((f) => f.form_name.toLowerCase().includes(needle));

  if (match) return match;

  const direct = await lookupFormById(ctx, formIdOrName);
  if (direct) return direct;

  const available = forms.map((f) => `${f.form_name} [${f.form_id}]`).join(", ") || "none";
  throw new Error(`No form matching "${formIdOrName}". Available: ${available}`);
}

export function getFormDetail(ctx, form) {
  return form.detail_url ? call(ctx, form.detail_url) : Promise.resolve(null);
}

// ---------------------------------------------------------------------------
// Shape normalisers — check these two first if anything looks wrong
// ---------------------------------------------------------------------------

const ROW_CONTAINERS = ["responses", "results", "data", "records", "rows", "items"];

export function toRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ROW_CONTAINERS) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

/** AJEMS nests a record's answers under `response`. */
export function rowData(row) {
  return row?.response ?? row?.data ?? row?.answers ?? row;
}

// ---------------------------------------------------------------------------
// Reading records
// ---------------------------------------------------------------------------

/**
 * The API returns every response in one call and ignores page parameters, so
 * fetch once and cap. Never loop on page= — it returns the same rows again.
 */
export async function fetchRows(ctx, form, maxRows = SCAN_LIMIT) {
  const key = nsRows(ctx, form.form_id);
  const fetchIt = () => call(ctx, form.list_url);

  // Peek at the cache first; only very large results bypass it.
  let payload = await cached(key, ROWS_TTL, fetchIt);
  if (toRows(payload).length > CACHE_MAX_ROWS) invalidate(key);

  const all = toRows(payload);
  const limit = Math.min(maxRows, SCAN_LIMIT);

  return {
    rows: all.slice(0, limit),
    total: payload?.count ?? all.length,
    labels: payload?.labels || {},
    // True only when the server ceiling was actually hit, which means numbers
    // computed from these rows are a lower bound.
    truncated: all.length > limit,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function schemaFromDetail(detail) {
  if (!Array.isArray(detail?.fields) || !detail.fields.length) return null;
  return detail.fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: (f.field_type || "unknown").toLowerCase(),
    ...(f.required ? { required: true } : {}),
    ...(f.options?.length ? { options: f.options } : {}),
  }));
}

/** Fallback when a form detail call gives us nothing usable. */
export function inferSchema(rows, labels = {}) {
  const seen = new Map();
  for (const row of rows.slice(0, 200)) {
    const data = rowData(row);
    if (!data || typeof data !== "object") continue;
    for (const [key, value] of Object.entries(data)) {
      if (!seen.has(key)) seen.set(key, new Set());
      if (value !== null && value !== undefined && value !== "") seen.get(key).add(String(value));
    }
  }
  return [...seen.entries()].map(([key, values]) => {
    const distinct = [...values];
    return {
      key,
      label: labels[key] || key,
      type: key.split("_")[0].toLowerCase() || "unknown",
      sample: distinct[0] ?? null,
      // Low-cardinality fields are almost certainly dropdowns — listing the
      // values lets the AI filter correctly without a second call.
      ...(distinct.length && distinct.length <= 15 ? { options: distinct } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Apps and forms (write)
// ---------------------------------------------------------------------------

export async function createApp(ctx, { title, description = "", icon = "", color = "" }) {
  const res = await call(ctx, "apps/", { method: "POST", body: { title, description, icon, color } });
  invalidate(nsConfig(ctx));
  return res;
}

export async function updateApp(ctx, appId, patch) {
  const res = await call(ctx, `apps/${encodeURIComponent(appId)}/`, { method: "PATCH", body: patch });
  invalidate(nsConfig(ctx));
  return res;
}

export async function getApp(ctx, appId) {
  return call(ctx, `apps/${encodeURIComponent(appId)}/`);
}

export async function updateForm(ctx, formId, patch) {
  const res = await call(ctx, `forms/${encodeURIComponent(formId)}/`, { method: "PATCH", body: patch });
  invalidate(nsConfig(ctx));
  return res;
}

/** AJEMS field keys are `<type>_<epoch ms>`; the index avoids same-millisecond collisions. */
function generateFieldKey(fieldType, index = 0) {
  return `${String(fieldType).toLowerCase()}_${Date.now() + index}`;
}

export async function createForm(ctx, { app_id, title, description = "", fields = [], allowWrites = true }) {
  const res = await call(ctx, "forms/", {
    method: "POST",
    body: {
      app_id,
      title,
      description,
      isMasterForm: false,
      // Enabled so this connector can read and write the form it just made.
      isThirdPartyEnabled: true,
      isThirdPartyGetAllowed: true,
      isThirdPartyPostAllowed: allowWrites,
      thirdPartyGetFields: [],
      thirdPartyPostFields: [],
      allowFormColStat: false,
      allowToClone: false,
      clonedBy: "",
      fields: fields.map((f, i) => ({
        field_type: f.field_type,
        label: f.label,
        required: !!f.required,
        isNew: false,
        key: f.key || generateFieldKey(f.field_type, i),
        ...(f.options?.length ? { options: f.options, multiple: !!f.multiple } : {}),
      })),
    },
  });
  invalidate(nsConfig(ctx));
  return res;
}

// ---------------------------------------------------------------------------
// Records (write)
// ---------------------------------------------------------------------------

export async function createRecord(ctx, form, data) {
  try {
    return await call(ctx, form.post_url, { method: "POST", body: data });
  } catch (e) {
    if (form.post_allowed === false) {
      throw new Error(`${e.message}\n\nHint: this form has isThirdPartyPostAllowed = false in AJEMS. Enable third-party POST on it and retry.`);
    }
    throw e;
  }
}

export function updateRecord(ctx, form, recordId, data) {
  const url = `${form.list_url.replace(/\/$/, "")}/${encodeURIComponent(recordId)}/`;
  return call(ctx, url, { method: "PATCH", body: data });
}

/** Call once after a batch of writes rather than per row. */
export function invalidateRows(ctx, formId) {
  invalidate(nsRows(ctx, formId));
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export const FILTER_OPS = [
  "equals", "not_equals", "contains",
  "gt", "lt", "gte", "lte",
  "is_empty", "not_empty",
];

function matches(raw, op, value) {
  const a = raw === undefined || raw === null ? "" : String(raw).toLowerCase();
  const b = String(value ?? "").toLowerCase();
  switch (op) {
    case "equals": return a === b;
    case "not_equals": return a !== b;
    case "contains": return a.includes(b);
    case "gt": return Number(raw) > Number(value);
    case "lt": return Number(raw) < Number(value);
    case "gte": return Number(raw) >= Number(value);
    case "lte": return Number(raw) <= Number(value);
    case "is_empty": return a === "";
    case "not_empty": return a !== "";
    default: return true;
  }
}

export function applyFilters(rows, filters = []) {
  if (!filters.length) return rows;
  return rows.filter((row) => {
    const data = rowData(row);
    return filters.every(({ field, op, value }) => matches(data?.[field], op, value));
  });
}

export function applyDateRange(rows, field, from, to) {
  if (!field || (!from && !to)) return rows;
  const start = from ? new Date(from).getTime() : -Infinity;
  const end = to ? new Date(to).getTime() + 86_399_999 : Infinity;

  return rows.filter((row) => {
    // Fall back to the record's own metadata for created_at / updated_at.
    const value = rowData(row)?.[field] ?? row?.[field];
    if (!value) return false;
    const ts = new Date(value).getTime();
    return !Number.isNaN(ts) && ts >= start && ts <= end;
  });
}
