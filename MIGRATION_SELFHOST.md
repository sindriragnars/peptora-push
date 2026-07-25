# Push/Redis self-host migration (off Vercel-managed Upstash)

Decision (Sindri, this session): self-host Redis + reminder scheduling on the
icelandvision VPS. No external Upstash. Push data starts fresh (no users yet).

## Why
`peptora-push-redis` (Upstash for Redis) and `upstash-qstash-cyan-island`
(QStash) were provisioned via the **Vercel marketplace**, so they die when the
Vercel account closes, and their secrets are unreadable via `vercel env pull`.
Both push (subscriptions/reminders) AND shop (order log) depend on that Redis.

## Target architecture
- **Redis/KeyDB container** on Coolify (project "peptora"), persistent volume.
- **SRH** (`hiett/serverless-redis-http`) container in front of it, so
  `@upstash/redis` keeps working UNCHANGED in both push and shop — only the
  REST URL + token envs change. Token = a generated `SRH_TOKEN`.
- **QStash dropped.** `sync-reminders` already stores reminders in Redis
  (`reminders:{id}`); an in-container **cron** (setInterval 60s in server.ts)
  scans every minute and fires any reminder due at this HH:MM on today's DOW.
  `reminder-tick` becomes an internal function (no webhook signature).

## Steps / status
1. [ ] Coolify: Redis (KeyDB) container + SRH proxy, internal reachable.
2. [ ] push: redis.ts stays on @upstash/redis to point at SRH. Drop qstash.ts.
       server.ts gains the cron. sync-reminders drops QStash calls.
       Remove @upstash/qstash dep.
3. [ ] Regenerate VAPID keypair + INTERNAL_PUSH_SECRET + CRON_SECRET.
       Set push envs: a_KV_REST_API_URL/TOKEN to SRH, VAPID_*, secrets.
4. [ ] shop: KV_REST_API_URL/TOKEN to same SRH (prefixed keys). Redeploy.
5. [ ] webapp: PUBLIC_VAPID_KEY = new public key,
       PUBLIC_PUSH_API_URL = https://push.peptora.app. Rebuild (build args).
6. [ ] Verify: subscribe then reminder due-time fires a push end-to-end.

## Live already (this session)
- peptora.app / app / shop / tenants on VPS (nginx + node), valid LE certs.
- push.peptora.app: node container (shell — needs step 3 creds to function).
- cms-auth.peptora.app: OAuth relay LIVE. GitHub OAuth App callback must be
  changed to https://cms-auth.peptora.app/api/callback (manual, Sindri).

## Coolify / ids
- API base http://187.124.214.246:8000/api/v1 ; token held by Sindri.
- project "peptora" uuid ytufufofcwkx1tic44rdvez7, server w149k0gisrpcxvc4uvhmpcja
- apps: web ban2ufqil2jfvj3uygjonn0o · webapp atjtr6uiaf9fvt4amn3f19dd ·
  shop eshjxzglkgjp8781g3ncq3qo · push rdxii3yeu6830cs3yov9fhdb ·
  cms-auth pbtgvhq8mv0x85a7y1fnytdk

## Still on Vercel (backup, intentional)
- DNS zone (ns1/ns2.vercel-dns.com) — registrar eNom. LAST thing to move;
  holds mail records (MX/SPF/DKIM/DMARC for mail.peptora.app + Resend).
- Old web/webapp/shop/push/cms deployments — frozen backups, not auto-updated.
