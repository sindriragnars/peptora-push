import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorizedInternal } from '../lib/auth.js';
import { sendPush, type PushPayload, type PushSubscriptionJSON } from '../lib/push.js';
import { redis, SUBS_SET, SUB_KEY } from '../lib/redis.js';

/**
 * Internal push fan-out endpoint. Two call shapes:
 *
 *   { id: "<sub-id>", payload: {...} }
 *     → send to one subscription
 *
 *   { all: true, payload: {...} }
 *     → send to every active subscription (used by news cron in Phase C)
 *
 * Auth: shared-secret Bearer token in `Authorization` header.
 * Never exposed to the browser — only worker-internal callers.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
	// Note: no CORS — this endpoint is server-to-server only.
	if (req.method !== 'POST') {
		res.status(405).json({ error: 'method_not_allowed' });
		return;
	}
	if (!isAuthorizedInternal(req)) {
		res.status(401).json({ error: 'unauthorized' });
		return;
	}

	const body = req.body as { id?: unknown; all?: unknown; payload?: unknown };
	const payload = body?.payload;
	if (!isValidPayload(payload)) {
		res.status(400).json({ error: 'invalid_payload' });
		return;
	}

	let targetIds: string[];
	if (body?.all === true) {
		targetIds = await redis().smembers(SUBS_SET);
	} else if (typeof body?.id === 'string') {
		targetIds = [body.id];
	} else {
		res.status(400).json({ error: 'missing_target' });
		return;
	}

	let sent = 0;
	let failed = 0;
	let evicted = 0;
	const r = redis();

	for (const id of targetIds) {
		const raw = await r.get<string>(SUB_KEY(id));
		if (!raw) {
			// Subscription disappeared between the set lookup and this read.
			await r.srem(SUBS_SET, id);
			continue;
		}
		let sub: PushSubscriptionJSON;
		try {
			sub = typeof raw === 'string' ? JSON.parse(raw) : (raw as PushSubscriptionJSON);
		} catch {
			await r.del(SUB_KEY(id));
			await r.srem(SUBS_SET, id);
			continue;
		}
		const result = await sendPush(sub, payload);
		if (result.ok) {
			sent++;
		} else if (result.gone) {
			await r.del(SUB_KEY(id));
			await r.srem(SUBS_SET, id);
			evicted++;
		} else {
			failed++;
			console.warn('push failed', { id, statusCode: result.statusCode, error: result.error });
		}
	}

	res.status(200).json({ sent, failed, evicted, attempted: targetIds.length });
}

function isValidPayload(p: unknown): p is PushPayload {
	if (!p || typeof p !== 'object') return false;
	const o = p as Record<string, unknown>;
	return typeof o.title === 'string' && typeof o.body === 'string';
}
