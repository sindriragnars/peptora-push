import type { VercelRequest, VercelResponse } from '@vercel/node';
import { qstashReceiver } from '../lib/qstash.js';
import { sendPush, type PushSubscriptionJSON } from '../lib/push.js';
import {
	redis,
	REMINDERS_KEY,
	SCHEDULES_KEY,
	SUB_KEY,
	type SyncedReminder
} from '../lib/redis.js';

/**
 * Called by QStash when a reminder's cron fires. Looks up the
 * reminder + subscription in Redis and sends the push.
 *
 * Auth: QStash signs every webhook with the project's signing key.
 * The receiver throws if the signature is missing or wrong, which
 * stops randos from hammering this endpoint and pushing notifications
 * to arbitrary subscription IDs.
 *
 * Body: { subId: string, reminderId: number }
 */

// Disable Vercel's auto JSON parser — QStash's signature is over
// the raw request body, so we need the bytes exactly as QStash sent
// them. We parse ourselves after verification.
export const config = {
	api: { bodyParser: false }
};

async function readRawBody(req: VercelRequest): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (req.method !== 'POST') {
		res.status(405).json({ error: 'method_not_allowed' });
		return;
	}

	const rawBody = await readRawBody(req);
	const signature = req.headers['upstash-signature'];
	if (typeof signature !== 'string') {
		res.status(401).json({ error: 'missing_signature' });
		return;
	}

	try {
		const valid = await qstashReceiver().verify({ signature, body: rawBody });
		if (!valid) {
			res.status(401).json({ error: 'invalid_signature' });
			return;
		}
	} catch (e) {
		console.warn('qstash verify threw', e);
		res.status(401).json({ error: 'verify_failed' });
		return;
	}

	let body: { subId?: unknown; reminderId?: unknown };
	try {
		body = JSON.parse(rawBody);
	} catch {
		res.status(400).json({ error: 'invalid_json' });
		return;
	}
	const subId = typeof body?.subId === 'string' ? body.subId : null;
	const reminderId = typeof body?.reminderId === 'number' ? body.reminderId : null;
	if (!subId || reminderId === null) {
		res.status(400).json({ error: 'invalid_payload' });
		return;
	}

	const r = redis();
	const subRaw = await r.get<string>(SUB_KEY(subId));
	if (!subRaw) {
		// Subscription was deleted but its QStash schedules outlived it.
		// Clean up so this doesn't fire again. (Schedule deletion fails
		// silently if the schedule is also gone — that's fine.)
		await cleanupOrphanedSchedules(subId);
		res.status(200).json({ skipped: 'subscription_gone' });
		return;
	}

	const remindersRaw = await r.get<string>(REMINDERS_KEY(subId));
	const reminders: SyncedReminder[] = !remindersRaw
		? []
		: typeof remindersRaw === 'string'
			? JSON.parse(remindersRaw)
			: (remindersRaw as SyncedReminder[]);
	const rem = reminders.find((x) => x.id === reminderId);
	if (!rem) {
		res.status(200).json({ skipped: 'reminder_gone' });
		return;
	}

	const sub: PushSubscriptionJSON =
		typeof subRaw === 'string' ? JSON.parse(subRaw) : (subRaw as PushSubscriptionJSON);
	const result = await sendPush(sub, {
		title: rem.peptideName,
		body: `${rem.dose} · kl. ${rem.time}`,
		url: '/doses',
		tag: `reminder-${rem.id}`,
		icon: '/icon.png'
	});

	if (!result.ok && result.gone) {
		// Subscription is permanently dead. Drop it.
		await r.del(SUB_KEY(subId));
		await r.del(REMINDERS_KEY(subId));
		await cleanupOrphanedSchedules(subId);
		res.status(200).json({ skipped: 'subscription_gone_410' });
		return;
	}

	res.status(200).json({ sent: result.ok ? 1 : 0, error: result.ok ? null : result.error });
}

async function cleanupOrphanedSchedules(subId: string) {
	const r = redis();
	const idsRaw = await r.get<string | string[]>(SCHEDULES_KEY(subId));
	if (!idsRaw) return;
	const ids: string[] = Array.isArray(idsRaw) ? idsRaw : JSON.parse(idsRaw as string);
	// Best-effort delete — we can't reach QStash from here without
	// importing the client which pulls in its env vars. Worst case
	// the orphan fires once more and re-triggers this same cleanup.
	await r.del(SCHEDULES_KEY(subId));
	console.log('cleared orphan schedules from redis', { subId, count: ids.length });
}
