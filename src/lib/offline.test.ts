import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDashboard } from './offline';

const stored = new Map<string, Response>();
const cache = {
	match: async (key: string) => stored.get(key)?.clone(),
	put: async (key: string, value: Response) => {
		stored.set(key, value.clone());
	}
};
const json = (value: unknown) =>
	new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	stored.clear();
	vi.stubGlobal('caches', { open: async () => cache });
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => json({ total: 12 }))
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('saved dashboard data', () => {
	it('persists the first successful read and reopens it offline', async () => {
		expect((await readDashboard('/api/data')).data).toEqual({ total: 12 });
		vi.stubGlobal('navigator', { onLine: false });
		const result = await readDashboard('/api/data');
		expect(result.data).toEqual({ total: 12 });
		expect(Date.parse(result.savedAt!)).not.toBeNaN();
	});
	it('shows saved data promptly when the connection stalls, then saves the eventual update', async () => {
		await readDashboard('/api/data');
		vi.useFakeTimers();
		let finish!: (response: Response) => void;
		vi.stubGlobal(
			'fetch',
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				})
		);
		const result = readDashboard('/api/data');
		await vi.advanceTimersByTimeAsync(1000);
		expect((await result).data).toEqual({ total: 12 });
		finish(json({ total: 24 }));
		await vi.advanceTimersByTimeAsync(0);
		vi.stubGlobal('navigator', { onLine: false });
		expect((await readDashboard('/api/data')).data).toEqual({ total: 24 });
	});
	it.each([
		() => new Response('Unavailable', { status: 503 }),
		() => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }),
		() => new Response('invalid', { headers: { 'content-type': 'application/json' } }),
		() => {
			const r = json({ total: 99 });
			Object.defineProperty(r, 'redirected', { value: true });
			return r;
		}
	])('does not replace saved data with an error or sign-in response', async (response) => {
		await readDashboard('/api/data');
		vi.stubGlobal('fetch', async () => response());
		expect((await readDashboard('/api/data')).data).toEqual({ total: 12 });
		vi.stubGlobal('navigator', { onLine: false });
		expect((await readDashboard('/api/data')).data).toEqual({ total: 12 });
	});
	it('bounds a first visit without saved data when the network never responds', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', () => new Promise(() => {}));
		const result = expect(readDashboard('/api/data')).rejects.toThrow(/connection|offline/i);
		await vi.advanceTimersByTimeAsync(9000);
		await result;
	});
	it('keeps date ranges separate', async () => {
		await readDashboard('/api/data?start=2026-01-01');
		vi.stubGlobal('navigator', { onLine: false });
		await expect(readDashboard('/api/data?start=2026-02-01')).rejects.toThrow(/saved|offline/i);
	});
	it('still loads online if browser storage is unavailable', async () => {
		vi.stubGlobal('caches', {
			open: async () => {
				throw new Error('Quota');
			}
		});
		expect((await readDashboard('/api/data')).data).toEqual({ total: 12 });
	});
});

it('keeps an explicit refresh pending until fresh data arrives', async () => {
	await readDashboard('/api/data');
	vi.useFakeTimers();
	let finish!: (response: Response) => void;
	vi.stubGlobal(
		'fetch',
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})
	);
	let resolved = false;
	const result = readDashboard('/api/data', fetch, { refresh: true }).then((value) => {
		resolved = true;
		return value;
	});
	await vi.advanceTimersByTimeAsync(1000);
	expect(resolved).toBe(false);
	finish(json({ total: 24 }));
	expect((await result).data).toEqual({ total: 24 });
});
it('reports a failed explicit refresh even when saved data exists', async () => {
	await readDashboard('/api/data');
	vi.stubGlobal('fetch', async () => new Response('Unavailable', { status: 503 }));
	await expect(readDashboard('/api/data', fetch, { refresh: true })).rejects.toThrow();
});

it('does not label an older session version as the new summary version', async () => {
	await readDashboard('/api/usage?sessions=1&version=a');
	vi.useFakeTimers();
	let finish!: (response: Response) => void;
	vi.stubGlobal(
		'fetch',
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})
	);
	let resolved = false;
	const result = readDashboard('/api/usage?sessions=1&version=b').then((value) => {
		resolved = true;
		return value;
	});
	await vi.advanceTimersByTimeAsync(1000);
	expect(resolved).toBe(false);
	finish(json({ total: 24 }));
	expect((await result).data).toEqual({ total: 24 });
});

it('cancels obsolete reads without saving their eventual response', async () => {
	const controller = new AbortController();
	let finish!: (response: Response) => void;
	vi.stubGlobal(
		'fetch',
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})
	);
	const pending = readDashboard('/api/data', fetch, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();
	finish(json({ total: 24 }));
	await expect(pending).rejects.toThrow();
	vi.stubGlobal('navigator', { onLine: false });
	await expect(readDashboard('/api/data')).rejects.toThrow(/saved|offline/i);
});

it('preserves the HTTP status for a dashboard with no data yet', async () => {
	vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
	await expect(readDashboard('/api/data')).rejects.toMatchObject({ cause: 404 });
});

it('allows a bounded finance cold read to finish after the short default deadline', async () => {
	vi.useFakeTimers();
	let finish!: (response: Response) => void;
	vi.stubGlobal(
		'fetch',
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})
	);
	let failure: unknown;
	const pending = readDashboard('/api/finance', fetch, { timeoutMs: 45000 }).catch((error) => {
		failure = error;
		return null;
	});
	await vi.advanceTimersByTimeAsync(9000);
	expect(failure).toBeUndefined();
	finish(json({ total: 24 }));
	expect((await pending)?.data).toEqual({ total: 24 });
});

it('still aborts a stalled extended read at its exact deadline', async () => {
	vi.useFakeTimers();
	let signal!: AbortSignal;
	vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
		signal = init.signal!;
		return new Promise(() => {});
	});
	let failure: unknown;
	const pending = readDashboard('/api/finance', fetch, { timeoutMs: 45000 }).catch((error) => {
		failure = error;
	});
	await vi.advanceTimersByTimeAsync(44999);
	expect(failure).toBeUndefined();
	expect(signal.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	await pending;
	expect(failure).toBeInstanceOf(Error);
	expect(signal.aborted).toBe(true);
});

it('keeps fast saved-data fallback with an extended network deadline', async () => {
	await readDashboard('/api/finance');
	vi.useFakeTimers();
	vi.stubGlobal('fetch', () => new Promise(() => {}));
	const pending = readDashboard('/api/finance', fetch, { timeoutMs: 45000 });
	await vi.advanceTimersByTimeAsync(750);
	expect((await pending).data).toEqual({ total: 12 });
	await vi.advanceTimersByTimeAsync(45000);
});
