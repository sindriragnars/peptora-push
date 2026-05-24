import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors.js';
import { qstash } from '../lib/qstash.js';
import {
	redis,
	REMINDERS_KEY,
	SCHEDULES_KEY,
	SUB_KEY,
	type SyncedReminder
} from '../lib/redis.js';

/**
 * Replace the full set of reminders for a subscription, then mirror
 * them into QStash schedules. Called by the WebApp every time the
 * user adds / edits / deletes a reminder.
 *
 * Whole-list replacement is simpler than diffing — the worker drops
 * every existing schedule for this subscription and creates fresh
 * ones from the incoming list. Cost: a few extra QStash API calls
 * per save. Worth it for correctness.
 *
 * QStash schedules use cron expressions. Each reminder fires once a
 * day at the specified time on the specified weekdays. Cron "MIN
 * HOUR DOM MON DOW" — we map days [0..6] (Sun..Sat) onto cron's
 * "0,1,2,3,4,5,6" (Sun..Sat). Times are stored as the user's local
 * 24-hour clock; QStash interprets cron in UTC, so the caller's
 * timezone must already be folded into `time`. The WebApp passes
 * its own local time; for the MVP we accept the resulting drift
 * across DST and document it.
 *
 * Auth: CORS-locked to app.peptora.app. The sub ID itself is the
 * implicit auth — anyone who possesses an ID can manage that
 * subscription (same model as /api/unsubscribe).
 *
 * Body: { id: string, reminders: SyncedReminder[] }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (handleCors(req, res)) return;
	if (req.method !== 'POST') {
		res.status(405).json({ error: 'method_not_allowed' });
		return;
	}

	const body = req.body as { id?: unknown; reminders?: unknown };
	const id = typeof body?.id === 'string' ? body.id : null;
	if (!id || !/^[a-f0-9]{32}$/.test(id)) {
		res.status(400).json({ error: 'invalid_id' });
		return;
	}
	if (!Array.isArray(body?.reminders)) {
		res.status(400).json({ error: 'invalid_reminders' });
		return;
	}
	const reminders = body.reminders.filter(isValidReminder);

	// Everything past here can throw (Redis, QStash). Wrap so a thrown
	// error still goes through res.json() — Vercel's default 500 path
	// drops the CORS headers handleCors set above, which surfaces in
	// the browser as an opaque "Failed to fetch" with no diagnostic.
	try {
		const r = redis();
		// Sanity-check the subscription exists. Stops orphan reminders
		// piling up in Redis after an unsubscribe.
		const subRaw = await r.get(SUB_KEY(id));
		if (!subRaw) {
			res.status(404).json({ error: 'subscription_not_found' });
			return;
		}

		// Tear down old schedules. Best-effort — QStash errors don't
		// block the new ones from being created.
		const oldScheduleIdsRaw = await r.get<string | null>(SCHEDULES_KEY(id));
		const oldScheduleIds: string[] = Array.isArray(oldScheduleIdsRaw)
			? oldScheduleIdsRaw
			: typeof oldScheduleIdsRaw === 'string'
				? JSON.parse(oldScheduleIdsRaw)
				: [];

		// Lazy QStash client init — skip entirely when there's nothing
		// to schedule or unschedule. Avoids hard-failing the request
		// just because QSTASH_TOKEN happens to be missing on a no-op.
		const needsQStash = oldScheduleIds.length > 0 || reminders.length > 0;
		const q = needsQStash ? qstash() : null;

		if (q) {
			await Promise.all(
				oldScheduleIds.map((sid) =>
					q.schedules.delete(sid).catch((e) => {
						console.warn('qstash delete failed', sid, e?.message);
					})
				)
			);
		}

		// Persist new reminder list + create new schedules.
		await r.set(REMINDERS_KEY(id), JSON.stringify(reminders));

		const newScheduleIds: string[] = [];
		const tickUrl = `${baseUrl(req)}/api/reminder-tick`;
		if (q) {
			for (const rem of reminders) {
				// `rem.time` was already validated as /^\d{2}:\d{2}$/ in
				// isValidReminder, so this split + parse is safe.
				const [hh = '0', mm = '0'] = rem.time.split(':');
				const dow = rem.days.length === 7 ? '*' : rem.days.join(',');
				const cron = `${parseInt(mm, 10)} ${parseInt(hh, 10)} * * ${dow}`;
				try {
					const result = await q.schedules.create({
						destination: tickUrl,
						cron,
						body: JSON.stringify({ subId: id, reminderId: rem.id }),
						headers: { 'Content-Type': 'application/json' }
					});
					newScheduleIds.push(result.scheduleId);
				} catch (e) {
					const msg = (e as Error).message;
					console.error('qstash schedule create failed', { rem, cron, msg });
				}
			}
		}
		await r.set(SCHEDULES_KEY(id), JSON.stringify(newScheduleIds));

		res.status(200).json({
			stored: reminders.length,
			scheduled: newScheduleIds.length,
			removedOld: oldScheduleIds.length
		});
	} catch (e) {
		const msg = (e as Error).message ?? String(e);
		console.error('sync-reminders failed', msg);
		res.status(500).json({ error: 'internal', message: msg });
	}
}

function isValidReminder(x: unknown): x is SyncedReminder {
	if (!x || typeof x !== 'object') return false;
	const r = x as Record<string, unknown>;
	return (
		typeof r.id === 'number' &&
		typeof r.peptideId === 'string' &&
		typeof r.peptideName === 'string' &&
		typeof r.dose === 'string' &&
		typeof r.time === 'string' &&
		/^\d{2}:\d{2}$/.test(r.time) &&
		Array.isArray(r.days) &&
		r.days.every((d) => typeof d === 'number' && d >= 0 && d <= 6)
	);
}

function baseUrl(req: VercelRequest): string {
	// Vercel sets x-forwarded-host + x-forwarded-proto. Fall back to
	// the request's own host header for local dev.
	const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
	const host =
		(req.headers['x-forwarded-host'] as string) ?? (req.headers.host as string);
	return `${proto}://${host}`;
}
