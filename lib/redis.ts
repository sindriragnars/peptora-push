import { Redis } from 'ioredis';

/**
 * Lazy Redis client. Self-hosted Redis on the icelandvision VPS (Coolify),
 * reached over the internal Docker network via REDIS_URL. Was Upstash's REST
 * client; now a thin wrapper over ioredis that keeps the same method surface
 * (get/set/smembers/sadd/srem/del) so the call sites are unchanged.
 *
 * `get<T>()` returns the raw string cast to T — every caller already does
 * `typeof raw === 'string' ? JSON.parse(raw) : raw`, so string values pass
 * straight through and the old Upstash generic signatures still type-check.
 */
class RedisClient {
	constructor(private readonly c: Redis) {}
	async get<T = string>(key: string): Promise<T | null> {
		const v = await this.c.get(key);
		return (v as unknown as T) ?? null;
	}
	set(key: string, value: string) {
		return this.c.set(key, value);
	}
	smembers(key: string) {
		return this.c.smembers(key);
	}
	sadd(key: string, member: string) {
		return this.c.sadd(key, member);
	}
	srem(key: string, member: string) {
		return this.c.srem(key, member);
	}
	del(key: string) {
		return this.c.del(key);
	}
}

let _client: RedisClient | null = null;
let _raw: Redis | null = null;

export function redis(): RedisClient {
	if (_client) return _client;
	const url = process.env.REDIS_URL;
	if (!url) throw new Error('REDIS_URL missing — set the internal redis:// URL.');
	_raw = new Redis(url, { maxRetriesPerRequest: 3 });
	_raw.on('error', (e) => console.error('redis error', e.message));
	_client = new RedisClient(_raw);
	return _client;
}

/* Redis keyspace layout
 * ---------------------
 *  sub:{id}         → PushSubscription JSON (set on subscribe)
 *  subs             → set of all active subscription IDs (for fan-out)
 *  reminders:{id}   → JSON array of SyncedReminder (set on sync-reminders)
 *  news:last_slugs  → JSON array of last-seen blog manifest slugs
 *
 * (schedules:{id} is gone — reminder firing is now an in-container cron,
 *  not per-reminder QStash schedules.)
 */
export const SUB_KEY = (id: string) => `sub:${id}`;
export const SUBS_SET = 'subs';
export const REMINDERS_KEY = (id: string) => `reminders:${id}`;
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
