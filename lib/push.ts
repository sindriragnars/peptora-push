import webPush from 'web-push';

/**
 * Configure the web-push library once with the VAPID identity
 * loaded from env vars. Subsequent `sendNotification` calls reuse
 * this configuration.
 */
let configured = false;
function ensureConfigured() {
	if (configured) return;
	const publicKey = process.env.VAPID_PUBLIC_KEY;
	const privateKey = process.env.VAPID_PRIVATE_KEY;
	const subject = process.env.VAPID_SUBJECT ?? 'mailto:info@peptora.app';
	if (!publicKey || !privateKey) {
		throw new Error('VAPID env vars missing — set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY.');
	}
	webPush.setVapidDetails(subject, publicKey, privateKey);
	configured = true;
}

export interface PushPayload {
	title: string;
	body: string;
	/** Where the SW should navigate when the user taps the notification. */
	url?: string;
	/** Optional tag — newer notifications with the same tag replace older ones. */
	tag?: string;
	/** Optional icon override. Defaults to /icon.png in the SW. */
	icon?: string;
}

export interface PushSubscriptionJSON {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export type SendResult =
	| { ok: true }
	| { ok: false; statusCode?: number; gone: boolean; error: string };

/**
 * Send a single notification. `gone: true` means the push service
 * (FCM, APNs, Mozilla) told us the subscription is permanently
 * dead (404/410) — caller should evict it from Redis.
 */
export async function sendPush(
	sub: PushSubscriptionJSON,
	payload: PushPayload
): Promise<SendResult> {
	ensureConfigured();
	try {
		await webPush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 });
		return { ok: true };
	} catch (e) {
		const err = e as { statusCode?: number; message?: string };
		const statusCode = err.statusCode;
		const gone = statusCode === 404 || statusCode === 410;
		return { ok: false, statusCode, gone, error: err.message ?? String(e) };
	}
}
