import { Redis } from '@upstash/redis';

/**
 * Lazy Upstash Redis client. Constructed on first use so module
 * import doesn't fail in environments missing env vars (CI, local
 * dev without secrets loaded).
 */
let _redis: Redis | null = null;

export function redis(): Redis {
	if (_redis) return _redis;
	// Vercel marketplace integration injects Upstash creds with a
	// prefix that we set when connecting the store ('a_' in our case).
	// Fall back to standard Upstash names for local-dev convenience.
	const url =
		process.env.a_KV_REST_API_URL ||
		process.env.KV_REST_API_URL ||
		process.env.UPSTASH_REDIS_REST_URL;
	const token =
		process.env.a_KV_REST_API_TOKEN ||
		process.env.KV_REST_API_TOKEN ||
		process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		throw new Error(
			'Upstash Redis env vars missing — expected a_KV_REST_API_URL + a_KV_REST_API_TOKEN.'
		);
	}
	_redis = new Redis({ url, token });
	return _redis;
}

/* Redis keyspace layout
 * ---------------------
 *  sub:{id}         → PushSubscription JSON (set on subscribe)
 *  subs             → set of all active subscription IDs (for fan-out)
 *  reminders:{id}   → JSON array of SyncedReminder (set on sync-reminders)
 *  schedules:{id}   → JSON array of QStash schedule IDs owned by sub
 *  news:last_slugs  → JSON array of last-seen blog manifest slugs (Phase C)
 */
export const SUB_KEY = (id: string) => `sub:${id}`;
export const SUBS_SET = 'subs';
export const REMINDERS_KEY = (id: string) => `reminders:${id}`;
export const SCHEDULES_KEY = (id: string) => `schedules:${id}`;
export const NEWS_SEEN_KEY = 'news:last_slugs';

export interface SyncedReminder {
	/** Local reminder id from the webapp (Dexie auto-increment). */
	id: number;
	peptideId: string;
	peptideName: string;
	dose: string;
	/** "HH:MM" 24-hour. */
	time: string;
	/** Days of week, 0 = Sun … 6 = Sat. */
	days: number[];
}
