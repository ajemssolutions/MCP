// tools.js — every tool the AI can call.
//
// A fresh McpServer is built per request with the caller's tenant baked into
// `ctx`. No tool schema has a tenant, org or URL parameter, so there is nothing
// for a model to be persuaded into changing.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getWorkspaceConfig, flattenForms, findForm, getFormDetail,
  fetchRows, createApp, createForm, createRecord, updateRecord, invalidateRows,
  schemaFromDetail, inferSchema, rowData,
  applyFilters, applyDateRange, FILTER_OPS,
} from "./ajems.js";
import { ok, fail, mapLimit } from "./util.js";

const MAX_ROWS = Number(process.env.MAX_ROWS || 2000);
const ALLOW_WRITES = process.env.ALLOW_WRITES === "true";

// Search scans records across forms, so it needs its own ceilings.
const SEARCH_MAX_FORMS = Number(process.env.SEARCH_MAX_FORMS || 15);
const SEARCH_MAX_ROWS = Number(process.env.SEARCH_MAX_ROWS || 500);
const SEARCH_MAX_RESULTS = Number(process.env.SEARCH_MAX_RESULTS || 40);
const WRITE_CONCURRENCY = 4;

const FILTER = z.object({
  field: z.string().describe("Field key from describe_form"),
  op: z.enum(FILTER_OPS),
  value: z.string().optional(),
});

const DATE_ARGS = {
  date_field: z.string().optional().describe("Field key the date range applies to. Use created_at for submission date."),
  date_from: z.string().optional().describe("YYYY-MM-DD"),
  date_to: z.string().optional().describe("YYYY-MM-DD"),
};

/** Shared by query and aggregate: resolve the form, load rows, apply date + filters. */
async function loadFiltered(ctx, args, maxRows = MAX_ROWS) {
  const form = await findForm(ctx, args.form);
  const { rows, labels, truncated } = await fetchRows(ctx, form, maxRows);
  let filtered = applyDateRange(rows, args.date_field, args.date_from, args.date_to);
  filtered = applyFilters(filtered, args.filters);
  return { form, rows: filtered, labels, truncated };
}

function aggregate({ rows, metric, metricField, groupBy }) {
  const groups = new Map();
  for (const row of rows) {
    const data = rowData(row);
    const key = groupBy ? String(data?.[groupBy] ?? "(empty)") : "all";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(data);
  }

  return [...groups.entries()]
    .map(([group, items]) => {
      if (metric === "count") return { group, count: items.length };

      const numbers = items
        .map((item) => Number(item?.[metricField]))
        .filter((n) => !Number.isNaN(n));
      const sum = numbers.reduce((a, b) => a + b, 0);

      const value =
        metric === "sum" ? sum :
        metric === "avg" ? (numbers.length ? Number((sum / numbers.length).toFixed(2)) : 0) :
        metric === "min" ? (numbers.length ? Math.min(...numbers) : null) :
                           (numbers.length ? Math.max(...numbers) : null);

      return { group, count: items.length, [metric]: value };
    })
    .sort((a, b) => b.count - a.count);
}

export function buildServer(ctx, audit) {
  const server = new McpServer({ name: "ajems", version: "2.0.0" });

  const tool = (name, config, handler) =>
    server.registerTool(name, config, async (args) => {
      try {
        return await handler(args);
      } catch (e) {
        return fail(e.message);
      }
    });

  // --- Read ----------------------------------------------------------------

  tool("list_apps_and_forms", {
    title: "List AJEMS apps and forms",
    description: "List every app and form in the connected AJEMS workspace. Call this first to find the form you need. Returns structure only, no record data.",
    inputSchema: {},
  }, async () => {
    const forms = flattenForms(await getWorkspaceConfig(ctx));
    audit("list_apps_and_forms", {}, forms.length);
    return ok({
      tenant: ctx.tenant,
      forms: forms.map((f) => ({
        app: f.app,
        app_id: f.app_id,
        form_id: f.form_id,
        form_name: f.form_name,
        readable: Boolean(f.list_url),
        writable: f.post_allowed === true,
      })),
    });
  });

  tool("describe_form", {
    title: "Describe an AJEMS form",
    description: "Get the field structure of one form: field keys, human-readable labels, types and dropdown options. AJEMS field keys are auto-generated (e.g. date_1750943312417), so you MUST call this before filtering or aggregating, and use the `label` values when reporting results to the user.",
    inputSchema: { form: z.string().describe("Form id or form name from list_apps_and_forms") },
  }, async ({ form: formRef }) => {
    const form = await findForm(ctx, formRef);
    const detail = await getFormDetail(ctx, form).catch(() => null);
    const { rows, total, labels } = await fetchRows(ctx, form, 200);
    const fields = schemaFromDetail(detail) || inferSchema(rows, labels);

    audit("describe_form", { form: formRef }, 0);
    return ok({
      form_id: form.form_id,
      form_name: form.form_name,
      app: form.app,
      record_count: total,
      fields,
    });
  });

  tool("query_responses", {
    title: "Query AJEMS records",
    description: "Fetch records from one form with optional filters, date range and field selection. Use `fields` to return only the columns you need. For counts and totals use aggregate_responses instead — it is far cheaper.",
    inputSchema: {
      form: z.string(),
      filters: z.array(FILTER).optional(),
      ...DATE_ARGS,
      fields: z.array(z.string()).optional().describe("Field keys to return. Omit for all."),
      limit: z.number().int().min(1).max(500).default(50),
    },
  }, async (args) => {
    const { form, rows, labels, truncated } = await loadFiltered(ctx, args);

    let records = rows.slice(0, args.limit).map((row) => ({ _id: row?._id, ...rowData(row) }));
    if (args.fields?.length) {
      records = records.map((r) => ({
        _id: r._id,
        ...Object.fromEntries(args.fields.map((k) => [k, r[k]])),
      }));
    }

    audit("query_responses", args, rows.length);
    return ok({
      form: form.form_name,
      matched: rows.length,
      returned: records.length,
      labels,
      records,
      ...(truncated ? { warning: `Only the first ${MAX_ROWS} records were scanned.` } : {}),
    });
  });

  tool("aggregate_responses", {
    title: "Aggregate AJEMS records",
    description: "Compute count, sum, avg, min or max over a form, optionally grouped by a field and filtered by date range. Use this for questions like 'how many entries this month' or 'total by city' rather than pulling raw records.",
    inputSchema: {
      form: z.string(),
      metric: z.enum(["count", "sum", "avg", "min", "max"]).default("count"),
      metric_field: z.string().optional().describe("Required for sum/avg/min/max"),
      group_by: z.string().optional().describe("Field key to group by"),
      filters: z.array(FILTER).optional(),
      ...DATE_ARGS,
    },
  }, async (args) => {
    if (args.metric !== "count" && !args.metric_field) {
      return fail(`metric_field is required for "${args.metric}". Call describe_form to find the numeric field key.`);
    }

    const { form, rows, truncated } = await loadFiltered(ctx, args);
    const results = aggregate({
      rows,
      metric: args.metric,
      metricField: args.metric_field,
      groupBy: args.group_by,
    });

    audit("aggregate_responses", args, rows.length);
    return ok({
      form: form.form_name,
      scanned: rows.length,
      metric: args.metric,
      results,
      ...(truncated ? { warning: `Only the first ${MAX_ROWS} records were scanned.` } : {}),
    });
  });

  // --- Write ---------------------------------------------------------------

  if (ALLOW_WRITES) {
    tool("create_app", {
      title: "Create an AJEMS app",
      description: "Create a new app (a container for forms) in the workspace. Confirm the name with the user first. Returns the new app_id, which create_form needs.",
      inputSchema: {
        title: z.string().describe("App name shown to users"),
        description: z.string().optional(),
        icon: z.string().optional().describe("PrimeIcons class, e.g. 'pi pi-car'"),
        color: z.string().optional().describe("e.g. 'cyan', 'blue'"),
      },
    }, async (args) => {
      const res = await createApp(ctx, args);
      audit("create_app", args, 1);
      return ok(res);
    });

    tool("create_form", {
      title: "Create an AJEMS form",
      description: "Create a form inside an existing app, defining its fields. Get app_id from list_apps_and_forms or create_app. Field keys are generated automatically — never invent them. Third-party read and write are enabled on the new form so this connector can use it immediately. Show the user the planned fields and get confirmation before calling.",
      inputSchema: {
        app_id: z.string().describe("Target app id"),
        title: z.string().describe("Form name"),
        description: z.string().optional(),
        fields: z.array(z.object({
          field_type: z.string().describe("Date, Text, Number, Dropdown, Textarea, Email, Phone, Checkbox, Time"),
          label: z.string().describe("Human-readable field name"),
          required: z.boolean().optional(),
          options: z.array(z.string()).optional().describe("Choices, for Dropdown only"),
          multiple: z.boolean().optional().describe("Allow multiple selections, for Dropdown only"),
        })).min(1).describe("Fields in display order"),
      },
    }, async (args) => {
      const res = await createForm(ctx, args);
      audit("create_form", { app_id: args.app_id, title: args.title, field_count: args.fields.length }, 1);
      return ok({
        created: true,
        form_id: res?.form_id,
        title: res?.title,
        fields: (res?.fields || []).map((f) => ({ key: f.key, label: f.label, type: f.field_type })),
        note: "Use these generated keys when adding records.",
      });
    });

    tool("create_record", {
      title: "Create AJEMS records",
      description: "Add one or more records to a form. Call describe_form first and use its exact field keys. Pass several objects in `records` to add multiple rows in one go. Confirm the values with the user before calling.",
      inputSchema: {
        form: z.string().describe("Form id or name"),
        records: z.array(z.record(z.any())).min(1).describe("Array of flat objects: field_key -> value"),
      },
    }, async ({ form: formRef, records }) => {
      const form = await findForm(ctx, formRef);

      const outcomes = await mapLimit(records, WRITE_CONCURRENCY, async (data, i) => {
        try {
          const res = await createRecord(ctx, form, data);
          return { ok: true, id: res?._id ?? `row ${i + 1}` };
        } catch (e) {
          return { ok: false, row: i + 1, error: e.message.slice(0, 200) };
        }
      });

      invalidateRows(ctx, form.form_id);
      const created = outcomes.filter((o) => o.ok);
      const errors = outcomes.filter((o) => !o.ok);

      audit("create_record", { form: formRef, count: records.length }, created.length);
      return ok({
        form: form.form_name,
        created: created.length,
        failed: errors.length,
        ...(errors.length ? { errors } : {}),
      });
    });

    tool("update_record", {
      title: "Update an AJEMS record",
      description: "Change fields on an existing record. Get the record id (_id) from query_responses first. Only the keys you pass are changed. Confirm with the user before calling.",
      inputSchema: {
        form: z.string(),
        record_id: z.string().describe("The _id from query_responses"),
        data: z.record(z.any()).describe("field_key -> new value, only the fields to change"),
      },
    }, async ({ form: formRef, record_id, data }) => {
      const form = await findForm(ctx, formRef);
      const res = await updateRecord(ctx, form, record_id, data);
      invalidateRows(ctx, form.form_id);
      audit("update_record", { form: formRef, record_id }, 1);
      return ok(res);
    });
  }

  // --- ChatGPT compatibility ------------------------------------------------
  // Outside Developer Mode, ChatGPT only calls tools named `search` and
  // `fetch`, ignoring everything above. These wrap the same data.

  tool("search", {
    title: "Search AJEMS",
    description: "Search across all forms and records in the AJEMS workspace. Returns matches with an id you can pass to fetch for full detail. Use this to find data by any keyword: a customer name, a city, a status, a form name.",
    inputSchema: { query: z.string().describe("What to look for") },
  }, async ({ query }) => {
    const needle = String(query).toLowerCase().trim();
    const forms = flattenForms(await getWorkspaceConfig(ctx));
    const results = [];

    // A form whose own name matches is a useful result in itself.
    for (const form of forms) {
      if (results.length >= SEARCH_MAX_RESULTS) break;
      if (form.form_name.toLowerCase().includes(needle) || form.app.toLowerCase().includes(needle)) {
        results.push({
          id: `form:${form.form_id}`,
          title: `${form.form_name} (form in ${form.app})`,
          text: `An AJEMS form in the ${form.app} app. Fetch this id for its structure and sample records.`,
        });
      }
    }

    for (const form of forms.slice(0, SEARCH_MAX_FORMS)) {
      if (results.length >= SEARCH_MAX_RESULTS) break;
      if (!form.list_url) continue;

      let rows = [];
      try {
        ({ rows } = await fetchRows(ctx, form, SEARCH_MAX_ROWS));
      } catch {
        continue; // a form we can't read shouldn't fail the whole search
      }

      for (const row of rows) {
        if (results.length >= SEARCH_MAX_RESULTS) break;
        const data = rowData(row) ?? {};
        const values = Object.values(data);
        if (!values.some((v) => String(v ?? "").toLowerCase().includes(needle))) continue;

        results.push({
          id: `${form.form_id}:${row?._id ?? ""}`,
          title: `${form.form_name} — ${String(values[0] ?? "record").slice(0, 60)}`,
          text: Object.entries(data).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(", ").slice(0, 400),
        });
      }
    }

    audit("search", { query }, results.length);
    return ok({ results });
  });

  tool("fetch", {
    title: "Fetch an AJEMS item",
    description: "Retrieve full detail for one id returned by search. An id like 'form:<form_id>' returns that form's structure and recent records; '<form_id>:<record_id>' returns a single record.",
    inputSchema: { id: z.string().describe("An id from search results") },
  }, async ({ id }) => {
    if (id.startsWith("form:")) {
      const form = await findForm(ctx, id.slice(5));
      const detail = await getFormDetail(ctx, form).catch(() => null);
      const { rows, total, labels } = await fetchRows(ctx, form, 20);
      const fields = schemaFromDetail(detail) || inferSchema(rows, labels);

      audit("fetch", { id }, rows.length);
      return ok({
        id,
        title: form.form_name,
        url: form.detail_url,
        text: JSON.stringify({ app: form.app, total_records: total, fields, sample: rows.slice(0, 10).map(rowData) }, null, 2),
      });
    }

    const separator = id.lastIndexOf(":");
    if (separator < 1) return fail(`Malformed id "${id}". Expected 'form:<form_id>' or '<form_id>:<record_id>'.`);

    const form = await findForm(ctx, id.slice(0, separator));
    const recordId = id.slice(separator + 1);
    const { rows, labels } = await fetchRows(ctx, form, MAX_ROWS);
    const row = rows.find((r) => String(r?._id) === recordId);
    if (!row) return fail(`No record ${recordId} in ${form.form_name}.`);

    audit("fetch", { id }, 1);
    return ok({
      id,
      title: `${form.form_name} record`,
      url: form.detail_url,
      text: JSON.stringify({ labels, record: rowData(row) }, null, 2),
    });
  });

  return server;
}

export const toolCount = ALLOW_WRITES ? 10 : 6;
