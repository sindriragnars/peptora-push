# peptora-push

Web Push backend for the Peptora WebApp (`app.peptora.app`).

VAPID-signed push delivery. Phase A — basic subscribe/unsubscribe/push.
Phase B (reminder cron) and Phase C (news manifest polling) land in
follow-up commits.

Architecture: see `Decisions/WebApp push architecture.md` in the
Obsidian vault.

## Stack

- **Vercel** functions (Node 20) under `/api/`
- **Upstash Redis** for subscription storage (provisioned from
  Vercel Storage → Marketplace)
- **web-push** library for VAPID-signed delivery
- No build step — Vercel runs the TS files directly via `@vercel/node`

## Endpoints

| Path                 | Method      | Auth                  | Purpose                                          |
| -------------------- | ----------- | --------------------- | ------------------------------------------------ |
| `/api/subscribe`     | POST        | CORS (app.peptora.app)| Register a PushSubscription, return its ID       |
| `/api/unsubscribe`   | POST/DELETE | CORS (app.peptora.app)| Drop a subscription by ID (idempotent)           |
| `/api/push`          | POST        | Bearer secret         | Internal fan-out — send to one ID or `all: true` |

## Env vars

See `.env.example`. Production values live in the Vercel project
settings; nothing is committed.

VAPID keypair is generated once via:

```
npx web-push generate-vapid-keys --json
```

The public key is also embedded in the WebApp as
`PUBLIC_VAPID_KEY` so the browser can call `pushManager.subscribe`.

## Manual test (Phase A acceptance)

```bash
# 1. From the WebApp, toggle Settings → Notifications on.
#    The browser hits /api/subscribe and stores the returned ID
#    in localStorage as `peptora.pushSubId`.

# 2. Send a test push from a shell:
curl -X POST https://peptora-push.vercel.app/api/push \
  -H "Authorization: Bearer $INTERNAL_PUSH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "<sub-id from step 1>",
    "payload": {
      "title": "Peptora test",
      "body": "Hello from the push backend.",
      "url": "/"
    }
  }'

# 3. The phone should ping. Tapping the notification opens the WebApp.
```

## Local dev

```bash
npm install
cp .env.example .env
# Fill in VAPID + Upstash + INTERNAL_PUSH_SECRET in .env
npx vercel dev
```
