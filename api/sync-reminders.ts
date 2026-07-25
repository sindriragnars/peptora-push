import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors.js';
import { redis, REMINDERS_KEY, SUB_KEY, type SyncedReminder } from '../lib/redis.js';

/**
 * Replace the full set of reminders for a subscription. Called by the WebApp
 * every time the user adds / edits / deletes a reminder.
 *
 * The reminders are just stored in Redis under `reminders:{id}`. The
 * in-container scheduler (see server.ts) scans these every minute and fires
 * any whose time + weekday match now — so there are no external schedules to
 * create or tear down anymore (this used to fan out one QStash schedule per
 * reminder). Whole-list replacement stays: simpler than diffing.
 *
 * Auth: CORS-locked to app.peptora.app. The sub ID is the implicit auth —
 * anyone holding an ID can manage that subscription (same as /api/unsubscribe).
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

	try {
		const r = redis();
		// Sanity-check the subscription exists. Stops orphan reminders piling
		// up in Redis after an unsubscribe.
		const subRaw = await r.get(SUB_KEY(id));
		if (!subRaw) {
			res.status(404).json({ error: 'subscription_not_found' });
			return;
		}

		await r.set(REMINDERS_KEY(id), JSON.stringify(reminders));
		res.status(200).json({ stored: reminders.length });
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
