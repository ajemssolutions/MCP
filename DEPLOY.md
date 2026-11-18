# Deploying the AJEMS connector (v5)

One codebase, two Vercel projects. Only the Environment Variables differ.

| | Staging | Live |
|---|---|---|
| Vercel project | `ajems-mcp-connector-staging` | `ajems-mcp-connector` |
| `PUBLIC_URL` | `https://ajems-mcp-connector-staging.vercel.app` | `https://ajems-mcp-connector.vercel.app` (later `https://mcp.ajems.com`) |
| `AJEMS_API_TEMPLATE` | `https://{org}.api.ajems-staging.com` | `https://{org}.buildprohub-server.com` |
| `AJEMS_WEB_TEMPLATE` | `https://{org}.ajems-staging.com` | `https://{org}.ajems.in` |
| `AJEMS_SERVER_SECRET` | = staging `Backend/.env` `AJEN_MCP_SERVER_SECRET` | = live `Backend/.env` `AJEN_MCP_SERVER_SECRET` |
| `SESSION_KEY` | its own (`openssl rand -hex 32`) | its own |
| `ENV_LABEL` | `Staging` | (empty) |
| `ALLOW_LOCAL_REDIRECTS` | (default) | `false` |

If Vercel gives a different address than the project name (the name is taken), use the address
it gives in `PUBLIC_URL` **and** in the server's `AJEN_MCP_SERVER_URL`.

## Vercel

1. New Project → import the `ajems-mcp` folder (Framework: Other; no build command needed).
2. Settings → Environment Variables: the values above → Redeploy.
3. Optional, recommended on live: Storage → Upstash for Redis → connect to the project, Redeploy.
   (Makes sign-in codes and write confirmations single-use across all Vercel instances.)
4. Open `<PUBLIC_URL>/health` — it must say `"ok": true`.
5. Creating an app can take longer than 60 s on a big design: on a paid Vercel plan raise
   `maxDuration` in `vercel.json` (up to 120 is set as BUILD_TIMEOUT_MS here).

## The AJEMS server it points at (Backend/.env)

```
AJEN_MCP_ENABLED=true
AJEN_MCP_SIGNING_KEY=<openssl rand -hex 32>         # signs codes and 7-day tokens; change = everyone signed out
AJEN_MCP_SERVER_SECRET=<openssl rand -hex 24>       # the same value as the connector's AJEMS_SERVER_SECRET
AJEN_MCP_SERVER_URL=https://ajems-mcp-connector-staging.vercel.app    # the connector's PUBLIC_URL (comma-separate several)
# optional: AJEN_MCP_TOKEN_DAYS=7  AJEN_MCP_WRITES=true  AJEN_MCP_BUILD=true  AJEN_MCP_RATE_PER_HOUR=600
```

## Add it in Claude

Settings → Connectors → Add custom connector → `<PUBLIC_URL>/mcp` → Connect → type the workspace
(e.g. `brandkatha`) → sign in on AJEMS → **Allow**. Use the production address of the Vercel
project, never a preview link (previews are behind Vercel's login).

## A normal server instead (later, mcp.ajems.com)

```bash
cp .env.example .env        # fill in
node server.js              # or: pm2 start server.js --name ajems-mcp
```
nginx: proxy `https://mcp.ajems.com` to `http://127.0.0.1:8080` (pass `X-Forwarded-For`).
