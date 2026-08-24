# AJEMS MCP Connector

Lets Claude and ChatGPT answer questions about an AJEMS workspace — and optionally create apps, forms and records — without anyone logging into AJEMS.

One deployment serves every tenant. Users sign in with their organisation name and AJEMS secret key.

---

## Files

| File | Role |
|---|---|
| `server.js` | Config, authentication, HTTP transport, health, shutdown |
| `tools.js` | Every tool the AI can call |
| `ajems.js` | The only module that talks to the AJEMS API |
| `oauth.js` | The OAuth handshake Claude and ChatGPT require |
| `cache.js` | Per-tenant caching and upstream concurrency limiting |
| `util.js` | Small shared helpers |
| `diagnose.js` | 11-step end-to-end checker |
| `mock-ajems.js` | Fake AJEMS with sample data, for testing without a live workspace |

---

## Quick start

```bash
npm install
cp .env.example .env      # set PUBLIC_URL and AJEMS_HOST_TEMPLATE
npm start
```

Verify against a real workspace:

```bash
node diagnose.js https://mcp.ajems.com <organisation> <secret-key>
```

Or try it with no AJEMS at all:

```bash
npm run mock              # terminal 1
# set AJEMS_HOST_TEMPLATE=http://localhost:9090/{org}/json_builder
npm start                 # terminal 2
node diagnose.js http://localhost:8080 testco test-secret-key
```

See `DEPLOY.md` for nginx, TLS, pm2 and tuning.

---

## Tools

Read-only by default. Set `ALLOW_WRITES=true` for the four write tools.

| Tool | Purpose |
|---|---|
| `list_apps_and_forms` | Discovery — every app and form, with readable/writable flags |
| `describe_form` | Field keys, human labels, types, dropdown options |
| `query_responses` | Records with filters, date range, field selection |
| `aggregate_responses` | count / sum / avg / min / max, optionally grouped |
| `create_app` | New app |
| `create_form` | New form; field keys generated automatically |
| `create_record` | One or many records, inserted with bounded concurrency |
| `update_record` | Change fields on an existing record |
| `search` | Keyword search across forms and records (ChatGPT) |
| `fetch` | Full detail for one search result (ChatGPT) |

`aggregate_responses` computes on the server. Without it, "total by city" would pull thousands of rows into the model's context and count them by hand — slow, expensive, and wrong past a certain size.

`search` and `fetch` exist because outside Developer Mode, ChatGPT only calls tools with those two names and ignores everything else.

---

## How a question gets answered

Claude asks *"how many entries in July, by city?"*:

1. `list_apps_and_forms` → finds the form
2. `describe_form` → learns that `date_1750943312417` is the date field and `dropdown_1750943301432` holds cities
3. `aggregate_responses` with a date range and `group_by` → gets three numbers back
4. Writes the answer in plain English

Field keys are auto-generated (`date_1750943312417`), which is why step 2 is not optional. The tool descriptions tell the model this, and it chains the calls itself.

---

## Tenant isolation

- Tenant comes from the session, resolved server-side from the bearer token
- **No tool schema has a `tenant`, `org` or `url` parameter** — nothing exists for a model to be talked into changing
- `ajems.js` is the only module issuing outbound requests, and only to that tenant's base URL
- Cache keys are namespaced by tenant *and* a hash of the secret key, so tenants can't read each other's cached entries and a rotated key self-expires
- Organisation names are stripped to subdomain-safe characters, so an entry like `evil.com/x` can't redirect the server elsewhere
- Every tool call is logged as JSON with tenant and user

When adding a tool, re-check the second point.

---

## Testing

46 checks pass against the mock: authentication, all 10 tools, filters, date ranges, the `created_at` fallback, grouped aggregation, bulk insert, cache invalidation after writes, error messages, tenant isolation, 20 concurrent users, and rate limiting.
