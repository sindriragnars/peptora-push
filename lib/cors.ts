import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Tight CORS — only origins in ALLOWED_ORIGINS (comma-separated env
 * var) get an Access-Control-Allow-Origin echoed back. Preflights
 * (OPTIONS) get a 204 with the same headers.
 *
 * Returns true if the request was a preflight and the response was
 * sent — callers should `return` immediately in that case.
 */
export function handleCors(req: VercelRequest, res: VercelResponse): boolean {
	const allowed = (process.env.ALLOWED_ORIGINS ?? 'https://app.peptora.app')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	const origin = req.headers.origin;
	if (origin && allowed.includes(origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin);
		res.setHeader('Vary', 'Origin');
	}
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	res.setHeader('Access-Control-Max-Age', '86400');

	if (req.method === 'OPTIONS') {
		res.status(204).end();
		return true;
	}
	return false;
}
