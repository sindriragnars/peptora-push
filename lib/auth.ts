import type { VercelRequest } from '@vercel/node';

/**
 * Constant-time string compare to avoid leaking the shared secret
 * through response timing. Falls back to !== for differing-length
 * strings (no information leaked because both branches are O(1)).
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

/**
 * Validate the `Authorization: Bearer <secret>` header against
 * INTERNAL_PUSH_SECRET. Used only on /api/push (the internal
 * fan-out endpoint — never called from the browser).
 */
export function isAuthorizedInternal(req: VercelRequest): boolean {
	const secret = process.env.INTERNAL_PUSH_SECRET;
	if (!secret) return false; // Misconfigured worker — fail closed.
	const header = req.headers.authorization;
	if (!header || !header.startsWith('Bearer ')) return false;
	const provided = header.slice('Bearer '.length);
	return timingSafeEqual(provided, secret);
}
