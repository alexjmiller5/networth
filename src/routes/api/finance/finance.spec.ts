import { describe, expect, it, vi } from 'vitest';
import { GET } from './+server';

const environment = { LIFE_HUB_URL: 'https://hub.example', LIFE_HUB_TOKEN: 'test-read-token' };
const event = (fetch: typeof globalThis.fetch, env = environment) =>
	({ fetch, platform: { env } }) as unknown as Parameters<typeof GET>[0];

describe('finance endpoint', () => {
	it('requires the configured hub and token before making requests', async () => {
		const fetch = vi.fn();
		await expect(GET(event(fetch, { ...environment, LIFE_HUB_TOKEN: '' }))).rejects.toMatchObject({
			status: 503
		});
		await expect(GET(event(fetch, { ...environment, LIFE_HUB_URL: '' }))).rejects.toMatchObject({
			status: 503
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('rejects malformed upstream data instead of returning a successful empty estate', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ unexpected: [] })));
		await expect(GET(event(fetch))).rejects.toMatchObject({ status: 502 });
	});

	it('rejects redirects without forwarding the hub credential', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(null, { status: 302, headers: { location: 'https://other.example' } })
		);
		await expect(GET(event(fetch))).rejects.toMatchObject({ status: 502 });
		for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
			expect(url).toBe(`${environment.LIFE_HUB_URL}/v1/rows/pull`);
			expect(init.redirect).toBe('manual');
		}
	});

	it('contains network and upstream errors without revealing their bodies', async () => {
		const fetch = vi.fn().mockRejectedValue(new Error('internal credential-bearing error'));
		await expect(GET(event(fetch))).rejects.toMatchObject({
			status: 502,
			body: { message: 'Finance data could not be loaded. Try refreshing.' }
		});
	});

	it('keeps the response private and does not expose the hub credential', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ rows: [] })));
		const response = await GET(event(fetch));
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(await response.text()).not.toContain(environment.LIFE_HUB_TOKEN);
	});
});
