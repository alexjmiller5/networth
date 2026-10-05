import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('$service-worker', () => ({ build: ['/app.js'], files: ['/icon.png'], version: 'next' }));
const handlers = new Map<string, (event: any) => void>();
const stored = new Map<string, Response>();
const deleted: string[] = [];
const cache = {
	addAll: async () => {},
	put: async (key: string, response: Response) => {
		stored.set(key, response.clone());
	},
	match: async (key: string) => stored.get(key)?.clone()
};
async function lifecycle(kind: string) {
	let result!: Promise<unknown>;
	handlers.get(kind)!({
		waitUntil: (promise: Promise<unknown>) => {
			result = promise;
		}
	});
	return result;
}
beforeEach(async () => {
	stored.clear();
	deleted.length = 0;
	handlers.clear();
	vi.resetModules();
	vi.stubGlobal('self', {
		location: new URL('https://dashboard.example/service-worker.js'),
		addEventListener: (kind: string, handler: any) => handlers.set(kind, handler),
		clients: { claim: async () => {} }
	});
	vi.stubGlobal('caches', {
		open: async () => cache,
		keys: async () => [
			'dashboard-shell-old',
			'dashboard-shell-next',
			'dashboard-data-v1',
			'unrelated'
		],
		delete: async (key: string) => {
			deleted.push(key);
		}
	});
	vi.stubGlobal(
		'fetch',
		async (path: string) =>
			new Response(path === '/' ? '<meta name="dashboard-shell" content="1">' : 'asset', {
				headers: { 'content-type': path === '/' ? 'text/html' : 'application/javascript' }
			})
	);
	await import('./service-worker');
});
afterEach(() => vi.unstubAllGlobals());
it('installs the app document and serves it on an offline home navigation', async () => {
	await lifecycle('install');
	vi.stubGlobal('fetch', async () => {
		throw new Error('Offline');
	});
	let result!: Promise<Response>;
	handlers.get('fetch')!({
		request: { method: 'GET', mode: 'navigate', url: 'https://dashboard.example/?saved=1' },
		respondWith: (r: Promise<Response>) => {
			result = r;
		}
	});
	expect(await (await result).text()).toContain('dashboard-shell');
});
it('rejects a login page without replacing the dashboard shell', async () => {
	vi.stubGlobal(
		'fetch',
		async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } })
	);
	await expect(lifecycle('install')).rejects.toThrow();
	expect(stored.has('/')).toBe(false);
});
it('cleans old shell versions without deleting data or unrelated caches', async () => {
	await lifecycle('activate');
	expect(deleted).toEqual(['dashboard-shell-old']);
});
it.each([
	{ method: 'GET', mode: 'navigate', url: 'https://dashboard.example/?online=1' },
	{ method: 'POST', mode: 'cors', url: 'https://dashboard.example/api/refresh' },
	{ method: 'GET', mode: 'cors', url: 'https://dashboard.example/api/finance' },
	{ method: 'GET', mode: 'navigate', url: 'https://dashboard.example/cdn-cgi/access/logout' },
	{ method: 'GET', mode: 'cors', url: 'https://other.example/app.js' }
])('leaves writes, API and authentication requests to the network', (request) => {
	let intercepted = false;
	handlers.get('fetch')!({
		request,
		respondWith: () => {
			intercepted = true;
		}
	});
	expect(intercepted).toBe(false);
});

it('rejects an HTML challenge in place of an application asset', async () => {
	vi.stubGlobal(
		'fetch',
		async (path: string) =>
			new Response(
				path === '/' ? '<meta name="dashboard-shell" content="1">' : '<html>Sign in</html>',
				{ headers: { 'content-type': 'text/html' } }
			)
	);
	await expect(lifecycle('install')).rejects.toThrow();
	expect(stored.has('/')).toBe(false);
});
