# peptora-push

VAPID-signed Web Push backend for the Peptora ecosystem. Lives at
`peptora-push.vercel.app`. Subscribes browsers, schedules reminder
firings via QStash, broadcasts new-article notifications.

## Stack

- **Vercel** functions (Node 20) under `/api/`
- **Upstash Redis** for subscription storage (provisioned via Vercel
  Storage marketplace; same instance is reused by peptora-shop for
  orders / signups / tenants)
- **web-push** library for VAPID-signed delivery
- **QStash** (Upstash) for scheduled reminder firings
- **No build step** — Vercel runs the TS files directly via `@vercel/node`

## Endpoints

- `POST /api/subscribe` — register a browser PushSubscription, return sub ID
- `POST /api/unsubscribe` — drop a subscription
- `POST /api/sync-reminders` — replace a sub's reminder list (called from
  peptora-webapp + peptora-shop after every reminder CRUD)
- `POST /api/qstash/reminder` — QStash-signed callback that fires a single
  reminder push at the scheduled time
- `POST /api/cron/news-poll` — Vercel Cron entry, polls
  `www.peptora.app/api/blog.json` and broadcasts pushes for new articles
- `POST /api/test` — manual smoke-test endpoint

## Consumers

- **peptora-webapp** `src/lib/push.ts` + `src/lib/reminders.ts`
- **peptora-shop** same module paths under per-tenant flow

Both call `/api/subscribe` once when the user enables push, then
`/api/sync-reminders` whenever reminders change. The shop's sync filters
out reminders past their `endsAt` before posting (protocol expiry).

## Conventions

Same as siblings. Push to `main` → Vercel auto-deploys.

## Architecture decision doc

See `Decisions/WebApp push architecture.md` in the user's Obsidian vault
for the original design + tradeoffs (separate backend vs. inline in webapp,
Redis vs. Postgres, QStash vs. cron-per-reminder).

## Gotchas

- Subscription IDs are random opaque strings stored in localStorage on the
  client. Lose it and the user has to re-subscribe (no recovery path).
- QStash schedule cap is per Upstash plan tier — high reminder counts may
  need batching. Hasn't bitten yet.
- Future TODO: when the shop sends `startsAt`/`endsAt` in the sync payload
  (already wired client-side, ignored here), use them to skip scheduling
  outside the protocol window instead of relying on the client to filter.
