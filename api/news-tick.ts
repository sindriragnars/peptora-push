import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendPush, type PushSubscriptionJSON } from '../lib/push.js';
import { redis, NEWS_SEEN_KEY, SUBS_SET, SUB_KEY } from '../lib/redis.js';

/**
 * Daily news polling. The in-container scheduler (server.ts) calls pollNews()
 * once a day; this HTTP handler stays as a manual trigger (curl with the
 * CRON_SECRET bearer). Flow:
 *
 *  1. Fetch the marketing site's blog manifest
 *  2. Compare slugs against `news:last_slugs` in Redis
 *  3. For each new slug → fan out one push per subscription
 *  4. Persist the updated slug set
 *
 * First-run bootstrap: when `news:last_slugs` is empty we mark every current
 * slug as seen WITHOUT pushing — otherwise launch would dump every old
 * article onto every user at once.
 */

const BLOG_MANIFEST_URL = 'https://www.peptora.app/api/blog.json';

interface BlogArticle {
	slug: string;
	title: string;
	title_is?: string;
	description?: string;
	description_is?: string;
	url: string;
}

interface BlogManifest {
	articles: BlogArticle[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (req.method !== 'POST' && req.method !== 'GET') {
		res.status(405).json({ error: 'method_not_allowed' });
		return;
	}
	if (!isAuthorizedCron(req)) {
		res.status(401).json({ error: 'unauthorized' });
		return;
	}
	try {
		res.status(200).json(await pollNews());
	} catch (e) {
		const msg = (e as Error).message ?? String(e);
		console.error('news-tick failed', msg);
		res.status(500).json({ error: 'internal', message: msg });
	}
}

/**
 * Poll the manifest and push one notification per newly-seen article. Shared
 * by the HTTP handler and the daily in-container scheduler. Returns a summary.
 */
export async function pollNews(): Promise<Record<string, number>> {
	const manifest = await fetchManifest();
	const currentSlugs = manifest.articles.map((a) => a.slug);

	const r = redis();
	const seenRaw = await r.get<string | string[] | null>(NEWS_SEEN_KEY);
	const seen: string[] = Array.isArray(seenRaw)
		? seenRaw
		: typeof seenRaw === 'string'
			? JSON.parse(seenRaw)
			: [];

	// Bootstrap: nothing seen yet → mark all as seen, send nothing.
	if (seen.length === 0) {
		await r.set(NEWS_SEEN_KEY, JSON.stringify(currentSlugs));
		return { bootstrapped: currentSlugs.length };
	}

	const seenSet = new Set(seen);
	const newArticles = manifest.articles.filter((a) => !seenSet.has(a.slug));
	if (newArticles.length === 0) {
		return { checked: currentSlugs.length, newArticles: 0 };
	}

	const subIds = await r.smembers(SUBS_SET);
	let totalSent = 0;
	let totalEvicted = 0;
	let totalFailed = 0;

	for (const article of newArticles) {
		const payload = {
			title: article.title_is || article.title,
			body: article.description_is || article.description || '',
			url: article.url,
			tag: `news-${article.slug}`,
			icon: '/icon.png'
		};
		for (const id of subIds) {
			const raw = await r.get<string>(SUB_KEY(id));
			if (!raw) {
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
				totalSent++;
			} else if (result.gone) {
				await r.del(SUB_KEY(id));
				await r.srem(SUBS_SET, id);
				totalEvicted++;
			} else {
				totalFailed++;
				console.warn('news push failed', {
					subId: id,
					slug: article.slug,
					statusCode: result.statusCode,
					error: result.error
				});
			}
		}
	}

	// Update seen set last — even if pushes failed we mark these slugs seen,
	// otherwise the next run would re-fanout every article and spam everyone.
	await r.set(NEWS_SEEN_KEY, JSON.stringify(currentSlugs));

	return {
		checked: currentSlugs.length,
		newArticles: newArticles.length,
		sent: totalSent,
		evicted: totalEvicted,
		failed: totalFailed
	};
}

function isAuthorizedCron(req: VercelRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false; // Fail closed — must be configured.
	const header = req.headers.authorization;
	if (!header || !header.startsWith('Bearer ')) return false;
	const provided = header.slice('Bearer '.length);
	if (provided.length !== secret.length) return false;
	let mismatch = 0;
	for (let i = 0; i < provided.length; i++) {
		mismatch |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
	}
	return mismatch === 0;
}

async function fetchManifest(): Promise<BlogManifest> {
	const res = await fetch(BLOG_MANIFEST_URL, { headers: { 'Cache-Control': 'no-cache' } });
	if (!res.ok) throw new Error(`blog manifest fetch failed: ${res.status}`);
	const json = (await res.json()) as BlogManifest;
	if (!Array.isArray(json?.articles)) throw new Error('blog manifest missing articles[]');
	return json;
}
