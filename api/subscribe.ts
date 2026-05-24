import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { handleCors } from '../lib/cors.js';
import { redis, SUBS_SET, SUB_KEY } from '../lib/redis.js';

/**
 * Register a PushSubscription. The client sends the JSON returned
 * by `pushManager.subscribe()`; we mint a random ID, store the
 * subscription against it, and return the ID so the client can
 * call /api/unsubscribe later.
 *
 * Anyone can subscribe — this is the on-ramp. Spam is limited by
 * the browser's own VAPID + push-service backpressure (and by
 * permanently evicting `gone` subscriptions in /api/push).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (handleCors(req, res)) return;
	if (req.method !== 'POST') {
		res.status(405).json({ error: 'method_not_allowed' });
		return;
	}

	const body = req.body as { subscription?: unknown };
	const sub = body?.subscription;
	if (!isValidSubscription(sub)) {
		res.status(400).json({ error: 'invalid_subscription' });
		return;
	}

	const id = crypto.randomBytes(16).toString('hex');
	try {
		const r = redis();
		await r.set(SUB_KEY(id), JSON.stringify(sub));
		await r.sadd(SUBS_SET, id);
	} catch (e) {
		console.error('redis write failed', e);
		res.status(500).json({ error: 'storage_unavailable' });
		return;
	}

	res.status(200).json({ id });
}

function isValidSubscription(s: unknown): s is { endpoint: string; keys: { p256dh: string; auth: string } } {
	if (!s || typeof s !== 'object') return false;
	const o = s as Record<string, unknown>;
	if (typeof o.endpoint !== 'string') return false;
	const k = o.keys as Record<string, unknown> | undefined;
	if (!k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return false;
	return true;
}
