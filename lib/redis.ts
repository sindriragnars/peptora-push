import { Redis } from '@upstash/redis';

/**
 * Lazy Upstash Redis client. Constructed on first use so module
 * import doesn't fail in environments missing env vars (CI, local
 * dev without secrets loaded).
 */
let _redis: Redis | null = null;

export function redis(): Redis {
	if (_redis) return _redis;
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		throw new Error(
			'Upstash Redis env vars missing — set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.'
		);
	}
	_redis = new Redis({ url, token });
	return _redis;
}

/* Redis keyspace layout
 * ---------------------
 *  sub:{id}         → PushSubscription JSON (set on subscribe)
 *  subs             → set of all active subscription IDs (for fan-out)
 */
export const SUB_KEY = (id: string) => `sub:${id}`;
export const SUBS_SET = 'subs';
