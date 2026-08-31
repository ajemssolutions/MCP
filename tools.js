// tools.js — every tool the AI can call.
//
// A fresh McpServer is built per request with the caller's tenant baked into
// `ctx`. No tool schema has a tenant, org or URL parameter, so there is nothing
// for a model to be persuaded into changing.
//
// Two rules run through this file:
//
//   1. NEVER MAKE THE MODEL COUNT. Every list carries an explicit total, placed
//      first in the response. Models that summarise long lists (ChatGPT does,
//      Claude mostly doesn't) otherwise return numbers that drift between
//      identical questions.
//
//   2. NO WRITE HAPPENS WITHOUT `confirm: true`. The first call returns a
//      preview and a warning instead of writing. Enforced here, not left to
//      the model's judgement.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getWorkspaceConfig, flattenForms, findForm, getFormDetail,
  fetchRows, createApp, updateApp, getApp, createForm, updateForm,
  createRecord, updateRecord, invalidateRows,
  schemaFromDetail, inferSchema, rowData,
  applyFilters, applyDateRange, FILTER_OPS,
} from "./ajems.js";
import { ok, fail, mapLimit } from "./util.js";
import { envFlag } from "./config.js";

// How many rows we will scan when computing a count or total. Counts are exact
// below this; above it they are reported as a lower bound.
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || 50000);

// Ceiling on how much record data we hand back to the model in one response.
// Large pages waste the model's context and get truncated by the client anyway.
const MAX_RETURN_CHARS = Number(process.env.MAX_RETURN_CHARS || 60000);

// Search scans records across forms, so it needs its own ceilings.
const SEARCH_MAX_FORMS = Number(process.env.SEARCH_MAX_FORMS || 15);
const SEARCH_MAX_ROWS = Number(process.env.SEARCH_MAX_ROWS || 500);
const SEARCH_MAX_RESULTS = Number(process.env.SEARCH_MAX_RESULTS || 40);
const WRITE_CONCURRENCY = 4;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const CREATES  = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const MODIFIES = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const CONFIRM = z.boolean().default(false).describe(
  "Must be true for the change to happen. Call once without it to get a preview, show that preview to the user, " +
  "and only call again with confirm: true if they agree."
);

/** Returned when a write tool is called without confirm: true. */
function needsConfirmation({ action, summary, details, warning }) {
  return ok({
    status: "CONFIRMATION REQUIRED — nothing has been changed yet",
    action,
    what_will_happen: summary,
    details,
    ...(warning ? { warning } : {}),
    next_step: "Show the user exactly what will change and ask them to confirm. If they say yes, call this tool again with confirm: true. If they say no or are unsure, do not call it again.",
  });
}

const FILTER = z.object({
  field: z.string().describe("Field key from show_form_fields"),
  op: z.enum(FILTER_OPS),
  value: z.string().optional(),
});

const DATE_ARGS = {
  date_field: z.string().optional().describe("Field key the date range applies to. Use created_at for submission date."),
  date_from: z.string().optional().describe("YYYY-MM-DD"),
  date_to: z.string().optional().describe("YYYY-MM-DD"),
};

/** Shared by query and aggregate: resolve the form, load rows, apply date + filters. */
async function loadFiltered(ctx, args, maxRows = SCAN_LIMIT) {
  const form = await findForm(ctx, args.form);
  const { rows, total, labels, truncated } = await fetchRows(ctx, form, maxRows);
  let filtered = applyDateRange(rows, args.date_field, args.date_from, args.date_to);
  filtered = applyFilters(filtered, args.filters);
  return { form, rows: filtered, totalInForm: total, labels, truncated };
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
  // Read at call time, not at import time: module evaluation order would
  // otherwise decide whether .env had been loaded yet.
  const ALLOW_WRITES = envFlag("ALLOW_WRITES");

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
    title: "See my apps and forms",
    description:
      "List every app and form in the AJEMS workspace. Call this first to find the form you need. " +
      "The response begins with total_apps and total_forms — when the user asks how many apps or forms they have, " +
      "report those numbers directly. Never count the list yourself; it may be long.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => {
    const forms = flattenForms(await getWorkspaceConfig(ctx));
    const apps = new Map();
    for (const f of forms) {
      if (!apps.has(f.app)) apps.set(f.app, { app: f.app, app_id: f.app_id, form_count: 0, forms: [] });
      const a = apps.get(f.app);
      a.form_count++;
      a.forms.push({
        form_id: f.form_id,
        form_name: f.form_name,
        readable: Boolean(f.list_url),
        writable: f.post_allowed === true,
      });
    }

    audit("list_apps_and_forms", {}, forms.length);
    return ok({
      total_apps: apps.size,
      total_forms: forms.length,
      tenant: ctx.tenant,
      apps: [...apps.values()],
    });
  });

  tool("show_form_fields", {
    title: "See what a form contains",
    description:
      "Get the field structure of one form: field keys, human-readable labels, types and dropdown options, plus how " +
      "many records it holds. AJEMS field keys are auto-generated (e.g. date_1750943312417), so you MUST call this " +
      "before filtering, counting or summarising, and use the `label` values when reporting to the user.",
    inputSchema: { form: z.string().describe("Form id or form name from list_apps_and_forms") },
    annotations: READ_ONLY,
  }, async ({ form: ref }) => {
    const form = await findForm(ctx, ref);
    const detail = await getFormDetail(ctx, form).catch(() => null);
    const { rows, total, labels } = await fetchRows(ctx, form, 200);
    const fields = schemaFromDetail(detail) || inferSchema(rows, labels);

    audit("show_form_fields", { form: ref }, 0);
    return ok({
      record_count: total,
      form_id: form.form_id,
      form_name: form.form_name,
      app: form.app,
      writable: form.post_allowed === true,
      fields,
    });
  });

  tool("count_records", {
    title: "Count records",
    description:
      "Return how many records a form holds, optionally narrowed by filters or a date range. USE THIS for any " +
      "'how many' question about records rather than fetching records and counting them — it returns an exact " +
      "number and cannot be truncated.",
    inputSchema: {
      form: z.string(),
      filters: z.array(FILTER).optional(),
      ...DATE_ARGS,
    },
    annotations: READ_ONLY,
  }, async (args) => {
    const narrowed = Boolean(args.filters?.length || args.date_from || args.date_to);

    // Unfiltered counts come straight from the API's own total, so form size is
    // irrelevant — no scanning, always exact.
    if (!narrowed) {
      const form = await findForm(ctx, args.form);
      const { total } = await fetchRows(ctx, form, 1);
      audit("count_records", args, total);
      return ok({ count: total, exact: true, filtered: false, form: form.form_name });
    }

    const { form, rows, totalInForm, truncated } = await loadFiltered(ctx, args);
    audit("count_records", args, rows.length);
    return ok({
      count: rows.length,
      exact: !truncated,
      total_records_in_form: totalInForm,
      filtered: true,
      form: form.form_name,
      ...(truncated
        ? { warning: `This form holds more than ${SCAN_LIMIT} records. Only the first ${SCAN_LIMIT} were scanned, so this count is a lower bound.` }
        : {}),
    });
  });

  tool("find_records", {
    title: "Find records",
    description:
      "Fetch records from one form with optional filters, date range and field selection. `total_matching_records` " +
      "is the true number of matches; `records` is only the page you asked for. Never count the `records` array to " +
      "answer a 'how many' question — use count_records instead.",
    inputSchema: {
      form: z.string(),
      filters: z.array(FILTER).optional(),
      ...DATE_ARGS,
      fields: z.array(z.string()).optional().describe("Field keys to return. Omit for all."),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: READ_ONLY,
  }, async (args) => {
    const { form, rows, labels, truncated } = await loadFiltered(ctx, args);

    let records = rows.slice(0, args.limit).map((r) => ({ _id: r?._id, ...rowData(r) }));
    if (args.fields?.length) {
      records = records.map((r) => ({
        _id: r._id,
        ...Object.fromEntries(args.fields.map((k) => [k, r[k]])),
      }));
    }

    // Trim by serialised size too: 500 wide records can swamp the model's context.
    let trimmedForSize = false;
    while (records.length > 1 && JSON.stringify(records).length > MAX_RETURN_CHARS) {
      records = records.slice(0, Math.floor(records.length * 0.7));
      trimmedForSize = true;
    }

    const capped = rows.length > records.length;
    audit("find_records", args, rows.length);
    return ok({
      total_matching_records: rows.length,
      total_is_exact: !truncated,
      records_shown: records.length,
      ...(capped
        ? { note: `Showing ${records.length} of ${rows.length} matches. The full count is total_matching_records — do not count the records array.` }
        : {}),
      ...(trimmedForSize ? { trimmed: "The page was shortened to keep the response a workable size." } : {}),
      form: form.form_name,
      labels,
      records,
      ...(truncated ? { warning: `This form holds more than ${SCAN_LIMIT} records; only the first ${SCAN_LIMIT} were searched.` } : {}),
    });
  });

  tool("summarise_records", {
    title: "Total or average records",
    description:
      "Compute a sum, average, minimum or maximum over a form, optionally grouped by a field and filtered by date. " +
      "Use this for questions like 'total sales by city' or 'average order value'. For a plain count use count_records.",
    inputSchema: {
      form: z.string(),
      metric: z.enum(["count", "sum", "avg", "min", "max"]).default("count"),
      metric_field: z.string().optional().describe("Required for sum/avg/min/max"),
      group_by: z.string().optional().describe("Field key to group by"),
      filters: z.array(FILTER).optional(),
      ...DATE_ARGS,
    },
    annotations: READ_ONLY,
  }, async (args) => {
    if (args.metric !== "count" && !args.metric_field) {
      return fail(`metric_field is required for "${args.metric}". Call show_form_fields to find the numeric field key.`);
    }

    const { form, rows, truncated } = await loadFiltered(ctx, args);
    const results = aggregate({
      rows, metric: args.metric, metricField: args.metric_field, groupBy: args.group_by,
    });

    audit("summarise_records", args, rows.length);
    return ok({
      records_included: rows.length,
      exact: !truncated,
      groups: results.length,
      metric: args.metric,
      form: form.form_name,
      results,
      ...(truncated
        ? { warning: `This form holds more than ${SCAN_LIMIT} records. Only the first ${SCAN_LIMIT} were included, so these totals are a lower bound.` }
        : {}),
    });
  });

  // --- Write ---------------------------------------------------------------

  if (ALLOW_WRITES) {

    tool("create_app", {
      title: "Create a new app",
      description:
        "Create a new app, which is a container for forms. Returns the new app_id, which create_form needs. " +
        "Call without confirm first to show the user what will be created.",
      inputSchema: {
        title: z.string().describe("App name shown to users"),
        description: z.string().optional(),
        icon: z.string().optional().describe("PrimeIcons class, e.g. 'pi pi-car'"),
        color: z.string().optional().describe("e.g. 'cyan', 'blue'"),
        confirm: CONFIRM,
      },
      annotations: CREATES,
    }, async (args) => {
      if (!args.confirm) {
        return needsConfirmation({
          action: "Create a new app",
          summary: `A new app named "${args.title}" will be created in the ${ctx.tenant} workspace.`,
          details: { title: args.title, description: args.description || "(none)" },
        });
      }
      const res = await createApp(ctx, args);
      audit("create_app", { title: args.title }, 1);
      return ok({ created: true, app_id: res?.app_id, title: res?.title });
    });

    tool("update_app", {
      title: "Rename or restyle an app",
      description:
        "Change an existing app's name, description, icon or colour. Only the values you pass are changed. " +
        "Call without confirm first to show the user the current values against the new ones.",
      inputSchema: {
        app_id: z.string().describe("From list_apps_and_forms"),
        title: z.string().optional(),
        description: z.string().optional(),
        icon: z.string().optional(),
        color: z.string().optional(),
        confirm: CONFIRM,
      },
      annotations: MODIFIES,
    }, async ({ app_id, confirm, ...patch }) => {
      const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (!Object.keys(changes).length) {
        return fail("Nothing to change — pass at least one of title, description, icon or color.");
      }

      if (!confirm) {
        const current = await getApp(ctx, app_id).catch(() => null);
        return needsConfirmation({
          action: "Change an existing app",
          summary: `The app "${current?.title ?? app_id}" will be modified.`,
          details: {
            currently: current
              ? { title: current.title, description: current.description, icon: current.icon, color: current.color }
              : "(could not read current values)",
            will_become: changes,
          },
          warning: "This changes an app that already exists in the workspace.",
        });
      }

      const res = await updateApp(ctx, app_id, changes);
      audit("update_app", { app_id, changes }, 1);
      return ok({ updated: true, app_id: res?.app_id ?? app_id, title: res?.title });
    });

    tool("create_form", {
      title: "Create a new form",
      description:
        "Create a form inside an existing app, defining its fields. Get app_id from list_apps_and_forms or create_app. " +
        "Field keys are generated automatically — never invent them. External read and write are enabled on the new " +
        "form so this connector can use it immediately. Call without confirm first to show the user the planned fields.",
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
        confirm: CONFIRM,
      },
      annotations: CREATES,
    }, async (args) => {
      if (!args.confirm) {
        return needsConfirmation({
          action: "Create a new form",
          summary: `A form named "${args.title}" with ${args.fields.length} field(s) will be created.`,
          details: {
            form_name: args.title,
            fields: args.fields.map((f) =>
              `${f.label} (${f.field_type}${f.required ? ", required" : ""}` +
              `${f.options?.length ? `, options: ${f.options.join(" / ")}` : ""})`),
          },
        });
      }
      const res = await createForm(ctx, args);
      audit("create_form", { title: args.title, field_count: args.fields.length }, 1);
      return ok({
        created: true,
        form_id: res?.form_id,
        title: res?.title,
        fields: (res?.fields || []).map((f) => ({ key: f.key, label: f.label, type: f.field_type })),
        note: "Use these generated keys when adding records.",
      });
    });

    tool("update_form", {
      title: "Change a form's settings",
      description:
        "Change an existing form's name or description, or turn external read and write access on or off. " +
        "Does not add or remove fields. Call without confirm first to show the user the current values.",
      inputSchema: {
        form: z.string().describe("Form id or name"),
        title: z.string().optional(),
        description: z.string().optional(),
        allow_external_read: z.boolean().optional().describe("Whether connectors like this one may read the form"),
        allow_external_write: z.boolean().optional().describe("Whether connectors like this one may add records"),
        confirm: CONFIRM,
      },
      annotations: MODIFIES,
    }, async ({ form: ref, confirm, title, description, allow_external_read, allow_external_write }) => {
      const target = await findForm(ctx, ref);

      const patch = {};
      if (title !== undefined) patch.title = title;
      if (description !== undefined) patch.description = description;
      if (allow_external_read !== undefined) {
        patch.isThirdPartyGetAllowed = allow_external_read;
        patch.isThirdPartyEnabled = true;
      }
      if (allow_external_write !== undefined) {
        patch.isThirdPartyPostAllowed = allow_external_write;
        patch.isThirdPartyEnabled = true;
      }
      if (!Object.keys(patch).length) return fail("Nothing to change — pass at least one setting.");

      if (!confirm) {
        return needsConfirmation({
          action: "Change a form's settings",
          summary: `The form "${target.form_name}" will be modified.`,
          details: {
            currently: { name: target.form_name, external_write_allowed: target.post_allowed },
            will_become: patch,
          },
          warning: "This changes a form that already exists and may already hold records.",
        });
      }

      const res = await updateForm(ctx, target.form_id, patch);
      audit("update_form", { form: ref, patch }, 1);
      return ok({ updated: true, form_id: res?.form_id ?? target.form_id, title: res?.title ?? target.form_name });
    });

    tool("add_records", {
      title: "Add records",
      description:
        "Add one or more records to a form. Call show_form_fields first and use its exact field keys. Pass several " +
        "objects in `records` to add multiple rows at once. Call without confirm first so the user can check the " +
        "values before anything is saved.",
      inputSchema: {
        form: z.string().describe("Form id or name"),
        records: z.array(z.record(z.any())).min(1).describe("Array of flat objects: field_key -> value"),
        confirm: CONFIRM,
      },
      annotations: CREATES,
    }, async ({ form: ref, records, confirm }) => {
      const form = await findForm(ctx, ref);

      if (!confirm) {
        return needsConfirmation({
          action: "Add records",
          summary: `${records.length} record(s) will be added to "${form.form_name}".`,
          details: { form: form.form_name, record_count: records.length, records: records.slice(0, 10) },
          warning: form.post_allowed === false
            ? "This form currently has external write access switched off in AJEMS, so the save may be rejected."
            : undefined,
        });
      }

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

      audit("add_records", { form: ref, count: records.length }, created.length);
      return ok({
        created: created.length,
        failed: errors.length,
        form: form.form_name,
        ...(errors.length ? { errors } : {}),
      });
    });

    tool("update_record", {
      title: "Update a record",
      description:
        "Change fields on one existing record. Get the record id (_id) from find_records first. Only the keys you " +
        "pass are changed. Call without confirm first — the preview shows current values next to the new ones so " +
        "the user can see exactly what is being overwritten.",
      inputSchema: {
        form: z.string(),
        record_id: z.string().describe("The _id from find_records"),
        data: z.record(z.any()).describe("field_key -> new value, only the fields to change"),
        confirm: CONFIRM,
      },
      annotations: MODIFIES,
    }, async ({ form: ref, record_id, data, confirm }) => {
      const form = await findForm(ctx, ref);

      if (!confirm) {
        const { rows, labels } = await fetchRows(ctx, form, SCAN_LIMIT);
        const row = rows.find((r) => String(r?._id) === record_id);
        if (!row) return fail(`No record ${record_id} in ${form.form_name}.`);
        const current = rowData(row) ?? {};

        return needsConfirmation({
          action: "Overwrite values on an existing record",
          summary: `${Object.keys(data).length} field(s) on one record in "${form.form_name}" will be overwritten.`,
          details: {
            record_id,
            changes: Object.entries(data).map(([k, v]) => ({
              field: labels?.[k] || k,
              current_value: current[k] ?? "(empty)",
              new_value: v,
            })),
          },
          warning: "The current values will be replaced and cannot be recovered from here.",
        });
      }

      const res = await updateRecord(ctx, form, record_id, data);
      invalidateRows(ctx, form.form_id);
      audit("update_record", { form: ref, record_id }, 1);
      return ok({ updated: true, record_id, form: form.form_name, record: res?.response ?? res });
    });
  }

  // --- ChatGPT compatibility ------------------------------------------------
  // Outside Developer Mode, ChatGPT only calls tools named `search` and
  // `fetch`, ignoring everything above. These wrap the same data.

  tool("search", {
    title: "Search everything",
    description:
      "Search across all forms and records in the AJEMS workspace. Returns matches with an id you can pass to fetch. " +
      "`total_matches` is the number found; `results` may be a shorter list. Never count `results` to answer a " +
      "'how many' question — use count_records on a specific form instead.",
    inputSchema: { query: z.string().describe("What to look for") },
    annotations: READ_ONLY,
  }, async ({ query }) => {
    const needle = String(query).toLowerCase().trim();
    const forms = flattenForms(await getWorkspaceConfig(ctx));
    const results = [];
    let totalMatches = 0;

    for (const form of forms) {
      if (form.form_name.toLowerCase().includes(needle) || form.app.toLowerCase().includes(needle)) {
        totalMatches++;
        if (results.length < SEARCH_MAX_RESULTS) {
          results.push({
            id: `form:${form.form_id}`,
            title: `${form.form_name} (form in ${form.app})`,
            text: `An AJEMS form in the ${form.app} app. Fetch this id for its structure and sample records.`,
          });
        }
      }
    }

    const scanned = forms.slice(0, SEARCH_MAX_FORMS);
    for (const form of scanned) {
      if (!form.list_url) continue;
      let rows = [];
      try {
        ({ rows } = await fetchRows(ctx, form, SEARCH_MAX_ROWS));
      } catch {
        continue;   // a form we cannot read shouldn't fail the whole search
      }

      for (const row of rows) {
        const data = rowData(row) ?? {};
        const values = Object.values(data);
        if (!values.some((v) => String(v ?? "").toLowerCase().includes(needle))) continue;

        totalMatches++;
        if (results.length >= SEARCH_MAX_RESULTS) continue;
        results.push({
          id: `${form.form_id}:${row?._id ?? ""}`,
          title: `${form.form_name} — ${String(values[0] ?? "record").slice(0, 60)}`,
          text: Object.entries(data).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(", ").slice(0, 400),
        });
      }
    }

    audit("search", { query }, totalMatches);
    return ok({
      total_matches: totalMatches,
      results_shown: results.length,
      ...(scanned.length < forms.length
        ? { note: `Only the first ${scanned.length} of ${forms.length} forms were scanned, so total_matches is a lower bound.` }
        : {}),
      results,
    });
  });

  tool("fetch", {
    title: "Open a search result",
    description: "Retrieve full detail for one id returned by search. An id like 'form:<form_id>' returns that form's structure and recent records; '<form_id>:<record_id>' returns a single record.",
    inputSchema: { id: z.string().describe("An id from search results") },
    annotations: READ_ONLY,
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
    const { rows, labels } = await fetchRows(ctx, form, SCAN_LIMIT);
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

export const toolCount = () => (envFlag("ALLOW_WRITES") ? 13 : 7);
