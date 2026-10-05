/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const name = `dashboard-shell-${version}`;
const assets = new Set([...build, ...files]);

worker.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(name);
			// A redirect or HTML login response must never become the offline app.
			const shell = await fetch('/', { redirect: 'error', cache: 'no-cache' });
			if (
				!shell.ok ||
				shell.redirected ||
				!(await shell.clone().text()).includes('<meta name="dashboard-shell" content="1"')
			) {
				throw new Error('Dashboard shell unavailable');
			}
			await Promise.all(
				[...assets].map(async (path) => {
					const response = await fetch(path, { redirect: 'error', cache: 'no-cache' });
					if (
						!response.ok ||
						response.redirected ||
						response.headers.get('content-type')?.includes('text/html')
					)
						throw new Error('Dashboard asset unavailable');
					await cache.put(path, response);
				})
			);
			await cache.put('/', shell);
		})()
	);
});

worker.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key.startsWith('dashboard-shell-') && key !== name) await caches.delete(key);
			}
			await worker.clients.claim();
		})()
	);
});

worker.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);
	if (request.method !== 'GET' || url.origin !== worker.location.origin) return;
	const home =
		request.mode === 'navigate' && url.pathname === '/' && !url.searchParams.has('online');
	if (!home && !assets.has(url.pathname)) return;
	event.respondWith(
		(async () => {
			const cache = await caches.open(name);
			return (await cache.match(home ? '/' : url.pathname)) ?? fetch(request);
		})()
	);
});
