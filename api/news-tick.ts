import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendPush, type PushSubscriptionJSON } from '../lib/push.js';
import { redis, NEWS_SEEN_KEY, SUBS_SET, SUB_KEY } from '../lib/redis.js';

/**
 * Daily news polling cron (v0.5 Phase C). Vercel hits this once a
 * day at 07:00 UTC (configured in vercel.json). Flow:
 *
 *  1. Fetch the WebApp's blog manifest at peptora.app/api/blog.json
 *  2. Compare slugs against `news:last_slugs` in Redis
 *  3. For each new slug → fan out one push per subscription with the
 *     article's title/description and a deep link to the blog post
 *  4. Persist the updated slug set
 *
 * First-run bootstrap: when `news:last_slugs` is empty (fresh Redis,
 * first deploy after Phase C lands), we mark every current slug as
 * seen WITHOUT pushing — otherwise the launch would dump every old
 * article as a notification onto every user at once.
 *
 * Auth: Vercel automatically attaches `Authorization: Bearer
 * <CRON_SECRET>` to scheduled invocations when CRON_SECRET is set
 * on the project. We reject anything else, so randos can't trigger
 * a re-fanout by curling the endpoint.
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
		// Vercel cron uses GET; manual triggers from curl can use either.
		res.status(405).json({ error: 'method_not_allowed' });
		return;
	}
	if (!isAuthorizedCron(req)) {
		res.status(401).json({ error: 'unauthorized' });
		return;
	}

	try {
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
			res.status(200).json({ bootstrapped: currentSlugs.length });
			return;
		}

		const seenSet = new Set(seen);
		const newArticles = manifest.articles.filter((a) => !seenSet.has(a.slug));

		if (newArticles.length === 0) {
			res.status(200).json({ checked: currentSlugs.length, newArticles: 0 });
			return;
		}

		// Fetch the full subscription list once. We re-use it across all
		// new articles so we don't re-query Redis per article.
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

		// Update seen set last — if pushes failed mid-loop we still want
		// to mark these slugs as seen, otherwise the next run would re-
		// fanout every article to the same subs and spam everyone.
		await r.set(NEWS_SEEN_KEY, JSON.stringify(currentSlugs));

		res.status(200).json({
			checked: currentSlugs.length,
			newArticles: newArticles.length,
			sent: totalSent,
			evicted: totalEvicted,
			failed: totalFailed
		});
	} catch (e) {
		const msg = (e as Error).message ?? String(e);
		console.error('news-tick failed', msg);
		res.status(500).json({ error: 'internal', message: msg });
	}
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
