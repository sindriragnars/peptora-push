/**
 * Standalone HTTP server wrapping the six Vercel-style handlers so the
 * backend runs as a plain node container on Coolify (push.peptora.app).
 * Each handler keeps its (req, res) shape; this shim provides the two
 * Vercel conveniences they rely on — a parsed `req.body` and chainable
 * `res.status().json()`.
 *
 * /api/reminder-tick is mounted with rawBody: the QStash signature is
 * computed over the raw bytes and the handler reads the stream itself,
 * so the shim must not consume it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import newsTick from './api/news-tick.js';
import push from './api/push.js';
import subscribe from './api/subscribe.js';
import syncReminders from './api/sync-reminders.js';
import unsubscribe from './api/unsubscribe.js';
import { startScheduler } from './lib/scheduler.js';

type Handler = (req: VercelRequest, res: VercelResponse) => void | Promise<void>;

// Reminder firing moved from a QStash webhook (/api/reminder-tick) to the
// in-container scheduler below — there's no per-reminder external schedule
// anymore, so that route is gone.
const ROUTES: Record<string, { handler: Handler; rawBody?: boolean }> = {
	'/api/subscribe': { handler: subscribe },
	'/api/unsubscribe': { handler: unsubscribe },
	'/api/sync-reminders': { handler: syncReminders },
	'/api/push': { handler: push },
	'/api/news-tick': { handler: newsTick }
};

function vercelify(res: ServerResponse): VercelResponse {
	const v = res as unknown as VercelResponse;
	v.status = (code: number) => {
		res.statusCode = code;
		return v;
	};
	v.json = (obj: unknown) => {
		if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
		res.end(JSON.stringify(obj));
		return v;
	};
	v.send = (body: unknown) => {
		res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
		return v;
	};
	return v;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	if (chunks.length === 0) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		return undefined;
	}
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://internal');
	if (url.pathname === '/healthz') {
		res.statusCode = 200;
		res.end('ok');
		return;
	}
	const route = ROUTES[url.pathname];
	if (!route) {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'application/json');
		res.end('{"error":"not_found"}');
		return;
	}
	const vreq = req as unknown as VercelRequest;
	vreq.query = Object.fromEntries(url.searchParams);
	const method = req.method ?? 'GET';
	if (!route.rawBody && method !== 'GET' && method !== 'OPTIONS' && method !== 'HEAD') {
		vreq.body = await readJson(req);
	}
	try {
		await route.handler(vreq, vercelify(res));
	} catch (e) {
		console.error('handler crashed', url.pathname, e);
		if (!res.headersSent) {
			res.statusCode = 500;
			res.setHeader('Content-Type', 'application/json');
			res.end('{"error":"internal"}');
		}
	}
});

const port = parseInt(process.env.PORT ?? '3000', 10);
server.listen(port, () => {
	console.log(`peptora-push listening on :${port}`);
	startScheduler();
});
