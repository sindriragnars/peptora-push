import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors.js';
import { redis, SUBS_SET, SUB_KEY } from '../lib/redis.js';

/**
 * Drop a subscription by ID. Idempotent — returns 200 whether the
 * subscription existed or not, so the client can fire-and-forget
 * on permission-revoke / sign-out flows.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (handleCors(req, res)) return;
	if (req.method !== 'POST' && req.method !== 'DELETE') {
		res.status(405).json({ error: 'method_not_allowed' });
		return;
	}

	const body = req.body as { id?: unknown };
	const id = typeof body?.id === 'string' ? body.id : null;
	if (!id || !/^[a-f0-9]{32}$/.test(id)) {
		res.status(400).json({ error: 'invalid_id' });
		return;
	}

	try {
		const r = redis();
		await r.del(SUB_KEY(id));
		await r.srem(SUBS_SET, id);
	} catch (e) {
		console.error('redis delete failed', e);
		res.status(500).json({ error: 'storage_unavailable' });
		return;
	}

	res.status(200).json({ ok: true });
}
