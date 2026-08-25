// mock-ajems.js — a fake AJEMS that mirrors json-builder-api-guide.
// Lets you exercise the connector without touching a live workspace.
//
//   node mock-ajems.js
//   then set AJEMS_HOST_TEMPLATE=http://localhost:9090/{org}/json_builder

import express from "express";

const PORT = 9090;
const KEY = "test-secret-key";
const FORM_ID = "685d46b8bd927fad31d86be2";
const APP_ID = "6890c1f6f6a3d8b1d4123456";

const app = express();
app.use(express.json());

const base = (org) => `http://localhost:${PORT}/${org}/json_builder`;
const cities = ["Pune", "Mumbai", "Nashik"];

const labels = {
  date_1750943312417: "Date",
  dropdown_1750943301432: "City",
  number_1750943386575: "Meter Reading",
};

const fields = [
  { field_type: "Date", label: "Date", required: true, key: "date_1750943312417" },
  { field_type: "Dropdown", label: "City", key: "dropdown_1750943301432", options: cities },
  { field_type: "Number", label: "Meter Reading", required: true, key: "number_1750943386575" },
];

const responses = Array.from({ length: Number(process.env.MOCK_ROWS || 40) }, (_, i) => {
  const n = i + 1;
  return {
    _id: `resp${n}`,
    form_id: FORM_ID,
    created_at: "2026-08-05T10:30:00Z",
    updated_at: "2026-08-05T10:30:00Z",
    response: {
      date_1750943312417: `2026-0${(n % 3) + 6}-${String((n % 28) + 1).padStart(2, "0")}`,
      dropdown_1750943301432: cities[n % 3],
      number_1750943386575: ((n % 5) + 1) * 10000,
    },
  };
});

const apps = [{ app_id: APP_ID, title: "Vehicle Operations" }];
const createdForms = {};

app.use((req, res, next) =>
  req.headers["x-json-builder-secret-key"] === KEY
    ? next()
    : res.status(401).json({ error: "bad key" }));

app.get("/:org/json_builder/workspace_config/", (req, res) => {
  const b = base(req.params.org);
  res.json({
    tenant: req.params.org,
    apps: [{
      app_id: APP_ID,
      title: "Vehicle Operations",
      description: "",
      icon: "pi pi-car",
      color: "cyan",
      forms: [{
        form_id: FORM_ID,
        app_id: APP_ID,
        title: "Vehicle Washing",
        description: "",
        fields: [],
        isThirdPartyEnabled: true,
        isThirdPartyGetAllowed: true,
        isThirdPartyPostAllowed: true,
        jsonBuilderUrls: {
          detail_get: { method: "GET", url: `${b}/forms/${FORM_ID}/` },
          response_list_get: { method: "GET", url: `${b}/forms/${FORM_ID}/responses/` },
          response_post: { method: "POST", url: `${b}/forms/${FORM_ID}/responses/`, sample_payload: {} },
        },
      }],
    }],
  });
});

app.get("/:org/json_builder/apps/", (req, res) =>
  res.json({ tenant: req.params.org, count: apps.length, results: apps }));

app.post("/:org/json_builder/apps/", (req, res) => {
  const created = { app_id: `app${Date.now()}`, ...req.body, forms: [] };
  apps.push(created);
  res.json(created);
});

app.post("/:org/json_builder/forms/", (req, res) => {
  const form_id = `form${Date.now()}`;
  createdForms[form_id] = { ...req.body, form_id, rows: [] };
  res.json({ ...req.body, form_id });
});

app.get("/:org/json_builder/forms/:fid/", (req, res) => {
  if (req.params.fid === FORM_ID) {
    return res.json({
      form_id: FORM_ID, title: "Vehicle Washing", fields, labels,
      sample_post_payload: { date_1750943312417: "2026-08-05", dropdown_1750943301432: "Pune", number_1750943386575: 16500 },
    });
  }
  const form = createdForms[req.params.fid];
  if (!form) return res.status(404).json({ error: "no such form" });
  res.json({
    ...form,
    labels: Object.fromEntries((form.fields || []).map((f) => [f.key, f.label])),
  });
});

app.get("/:org/json_builder/forms/:fid/responses/", (req, res) => {
  if (req.params.fid === FORM_ID) {
    return res.json({ form_id: FORM_ID, form_title: "Vehicle Washing", labels, responses, count: responses.length });
  }
  const form = createdForms[req.params.fid];
  if (!form) return res.status(404).json({ error: "no such form" });
  res.json({
    form_id: form.form_id,
    form_title: form.title,
    responses: form.rows,
    count: form.rows.length,
    labels: Object.fromEntries((form.fields || []).map((f) => [f.key, f.label])),
  });
});

app.post("/:org/json_builder/forms/:fid/responses/", (req, res) => {
  const record = {
    _id: `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    form_id: req.params.fid,
    created_at: new Date().toISOString(),
    response: req.body,
  };
  if (req.params.fid === FORM_ID) responses.push(record);
  else if (createdForms[req.params.fid]) createdForms[req.params.fid].rows.push(record);
  else return res.status(404).json({ error: "no such form" });
  res.json(record);
});

app.get("/:org/json_builder/apps/:aid/", (req, res) => {
  const app_ = apps.find((a) => a.app_id === req.params.aid);
  if (!app_) return res.status(404).json({ error: "no such app" });
  res.json(app_);
});

app.patch("/:org/json_builder/apps/:aid/", (req, res) => {
  const app_ = apps.find((a) => a.app_id === req.params.aid);
  if (!app_) return res.status(404).json({ error: "no such app" });
  Object.assign(app_, req.body);
  res.json(app_);
});

app.patch("/:org/json_builder/forms/:fid/", (req, res) => {
  const form = createdForms[req.params.fid];
  if (req.params.fid === FORM_ID) return res.json({ form_id: FORM_ID, title: req.body.title || "Vehicle Washing", ...req.body });
  if (!form) return res.status(404).json({ error: "no such form" });
  Object.assign(form, req.body);
  res.json(form);
});

app.patch("/:org/json_builder/forms/:fid/responses/:rid/", (req, res) => {
  const record = responses.find((r) => r._id === req.params.rid);
  if (!record) return res.status(404).json({ error: "no such response" });
  Object.assign(record.response, req.body);
  res.json(record);
});

app.listen(PORT, () => console.log(`mock AJEMS on ${PORT} (secret key: ${KEY})`));
