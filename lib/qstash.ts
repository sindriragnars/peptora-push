import { Client, Receiver } from '@upstash/qstash';

/**
 * Upstash QStash — scheduled HTTP message queue. We use it to fire
 * reminder push notifications at exact times. Each reminder becomes
 * one or more QStash schedules; the schedule POSTs to our
 * /api/reminder-tick endpoint at the right minute, which then sends
 * the push via web-push.
 *
 * Env vars: QSTASH_TOKEN (write side), QSTASH_CURRENT_SIGNING_KEY +
 * QSTASH_NEXT_SIGNING_KEY (signature verification on incoming
 * webhooks). All injected by the Vercel marketplace integration.
 */

let _client: Client | null = null;
let _receiver: Receiver | null = null;

export function qstash(): Client {
	if (_client) return _client;
	const token = process.env.QSTASH_TOKEN;
	if (!token) throw new Error('QSTASH_TOKEN missing');
	_client = new Client({ token });
	return _client;
}

export function qstashReceiver(): Receiver {
	if (_receiver) return _receiver;
	const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
	const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
	if (!currentSigningKey || !nextSigningKey) {
		throw new Error('QSTASH signing keys missing');
	}
	_receiver = new Receiver({ currentSigningKey, nextSigningKey });
	return _receiver;
}
