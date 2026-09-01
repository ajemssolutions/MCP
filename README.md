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

| Tool | Shown as | Purpose |
|---|---|---|
| `list_apps_and_forms` | See my apps and forms | Discovery; returns `total_apps` and `total_forms` |
| `show_form_fields` | See what a form contains | Field keys, labels, types, options, record count |
| `count_records` | Count records | An exact number, optionally filtered |
| `find_records` | Find records | Records with filters, date range, field selection |
| `summarise_records` | Total or average records | sum / avg / min / max, optionally grouped |
| `create_app` | Create a new app | |
| `update_app` | Rename or restyle an app | |
| `create_form` | Create a new form | Field keys generated automatically |
| `update_form` | Change a form's settings | Name, description, external read/write access |
| `add_records` | Add records | One or many, bounded concurrency |
| `update_record` | Update a record | Only the fields you pass |
| `search` | Search everything | Keyword search across forms (ChatGPT) |
| `fetch` | Open a search result | Full detail for one result (ChatGPT) |

Read-only by default. Set `ALLOW_WRITES=true` for the six write tools.

## Two rules the tools follow

**Never make the model count.** Every list carries an explicit total, placed first
in the response. Models that summarise long lists return numbers that drift between
identical questions; `count_records` exists so a "how many" question never depends
on counting an array.

**No write happens without `confirm: true`.** The first call returns a preview and a
warning instead of writing. For `update_record` the preview shows current values next
to the new ones. This is enforced in the tool, not left to the model's judgement.

`summarise_records` computes on the server. Without it, "total by city" would pull
thousands of rows into the model's context and add them by hand — slow, expensive,
and wrong past a certain size.

`search` and `fetch` keep those exact names because outside Developer Mode, ChatGPT
only calls tools named `search` and `fetch` and ignores everything else.

---

## How a question gets answered

Claude asks *"how many entries in July, by city?"*:

1. `list_apps_and_forms` → finds the form
2. `show_form_fields` → learns that `date_1750943312417` is the date field and `dropdown_1750943301432` holds cities
3. `summarise_records` with a date range and `group_by` → gets three numbers back
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

## How disconnects are detected (and the honest limitation)

The Connector Store shows a Claude/ChatGPT card as Connected only while this
server vouches for it. Three paths take a card down; know which one you are
relying on:

**1. Client-initiated revocation — instant, but NOT guaranteed.**
This server implements RFC 7009: it advertises `revocation_endpoint` in its
OAuth metadata and serves `POST /revoke`. A client that calls it on
disconnect gets the exact session invalidated and one `status:"disconnected"`
report sent within seconds. **However: nothing obliges claude.ai to call
it.** Anthropic's connector documentation specifies no signal of any kind on
connector removal, the MCP authorization spec does not reference RFC 7009 at
all (clients are neither required nor recommended to revoke on disconnect),
and in production claude.ai has been observed removing a connector silently.
Whether claude.ai caches the OAuth metadata per connector (so a later-added
revocation endpoint is only picked up after remove + re-add) is also
undocumented. Treat instant detection as best-effort, never as a guarantee.

**2. Dashboard Disconnect — instant and always available.**
Clicking Disconnect on the Store card takes effect immediately and sticks:
heartbeats and check-status never resurrect it; only a fresh sign-in
(`reconnect: true`) does. This is the reliable way to take a card down *now*.

**3. Dormancy fallback — guaranteed, within the activity window.**
`lastSeen` advances only on genuine authenticated MCP requests. A session
with no traffic for `CONNECTOR_ACTIVE_WINDOW_MS` (default 1 hour) goes
dormant: one `status:"disconnected"` report is sent and heartbeats stop, so
a silent claude.ai removal shows as Disconnected within roughly the window
plus one heartbeat (~65 minutes at defaults). A dormant session that speaks
again reports back the moment it wakes. Shortening the window makes silent
removals surface faster, but marks genuinely-connected-but-idle users
Disconnected between uses — they reconnect automatically on their next
request, at the cost of the card flapping. 1 hour is the compromise.

There is no fourth option: when the client sends nothing and the user clicks
nothing, absence of traffic is the only signal, and it is indistinguishable
from idleness until the window expires.

References: [Anthropic remote-MCP connector docs](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp) ·
[MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization) ·
[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html)

---

## Testing

27 checks pass against the mock covering the tool layer: all 13 tools present with
correct annotations, explicit totals, filtered counts, the confirmation gate blocking
and then allowing every write, before/after previews, and search totals. An earlier
suite covers authentication, tenant isolation, 20 concurrent users and rate limiting.
