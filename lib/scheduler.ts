import { pollNews } from '../api/news-tick.js';
import { sendPush, type PushSubscriptionJSON } from './push.js';
import { redis, REMINDERS_KEY, SUBS_SET, SUB_KEY, type SyncedReminder } from './redis.js';

/**
 * In-container scheduler — the replacement for Vercel Cron + QStash.
 *
 * Every minute it scans each subscription's stored reminders and fires any
 * whose `time` (HH:MM) and weekday match now. Times are compared in UTC to
 * preserve the old QStash semantics: the WebApp already folds the user's
 * local time into `time` before syncing (documented DST drift is unchanged).
 *
 * Once a day at 07:00 UTC it also runs the news poll.
 *
 * A reminder fires at most once per matching minute. A container restart
 * inside the same minute could re-fire — rare and low-harm for a reminder.
 */

const NEWS_HOUR_UTC = 7;
let lastNewsDay = -1;

export function startScheduler(): void {
	// Align the first tick to the top of the next minute, then run every 60s.
	const now = new Date();
	const msToNextMinute = (60 - now.getUTCSeconds()) * 1000 - now.getUTCMilliseconds();
	setTimeout(() => {
		void tick();
		setInterval(() => void tick(), 60_000);
	}, msToNextMinute);
	console.log('scheduler started; first tick in', Math.round(msToNextMinute / 1000), 's');
}

async function tick(): Promise<void> {
	const now = new Date();
	const hh = String(now.getUTCHours()).padStart(2, '0');
	const mm = String(now.getUTCMinutes()).padStart(2, '0');
	const hhmm = `${hh}:${mm}`;
	const dow = now.getUTCDay(); // 0 = Sun … 6 = Sat

	try {
		await fireDueReminders(hhmm, dow);
	} catch (e) {
		console.error('reminder scan failed', (e as Error).message);
	}

	// Daily news poll, once, when the 07:00 UTC minute rolls around.
	if (
		now.getUTCHours() === NEWS_HOUR_UTC &&
		now.getUTCMinutes() === 0 &&
		lastNewsDay !== now.getUTCDate()
	) {
		lastNewsDay = now.getUTCDate();
		try {
			const summary = await pollNews();
			console.log('news poll', summary);
		} catch (e) {
			console.error('news poll failed', (e as Error).message);
		}
	}
}

async function fireDueReminders(hhmm: string, dow: number): Promise<void> {
	const r = redis();
	const subIds = await r.smembers(SUBS_SET);
	for (const subId of subIds) {
		const remindersRaw = await r.get<string>(REMINDERS_KEY(subId));
		if (!remindersRaw) continue;
		let reminders: SyncedReminder[];
		try {
			reminders = typeof remindersRaw === 'string' ? JSON.parse(remindersRaw) : remindersRaw;
		} catch {
			continue;
		}
		for (const rem of reminders) {
			if (rem.time === hhmm && rem.days.includes(dow)) {
				await fireReminder(subId, rem);
			}
		}
	}
}

/** Send one reminder push; evict the subscription if it's permanently dead. */
async function fireReminder(subId: string, rem: SyncedReminder): Promise<void> {
	const r = redis();
	const subRaw = await r.get<string>(SUB_KEY(subId));
	if (!subRaw) {
		await r.srem(SUBS_SET, subId);
		await r.del(REMINDERS_KEY(subId));
		return;
	}
	let sub: PushSubscriptionJSON;
	try {
		sub = typeof subRaw === 'string' ? JSON.parse(subRaw) : (subRaw as PushSubscriptionJSON);
	} catch {
		await r.del(SUB_KEY(subId));
		await r.srem(SUBS_SET, subId);
		return;
	}
	const result = await sendPush(sub, {
		title: rem.peptideName,
		body: `${rem.dose} · kl. ${rem.time}`,
		url: '/doses',
		tag: `reminder-${rem.id}`,
		icon: '/icon.png'
	});
	if (!result.ok && result.gone) {
		await r.del(SUB_KEY(subId));
		await r.del(REMINDERS_KEY(subId));
		await r.srem(SUBS_SET, subId);
	}
}
