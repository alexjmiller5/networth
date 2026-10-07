/** Last successful read, kept on this device independently of app deployments. */
export async function readDashboard<T>(
	url: string,
	request: typeof fetch = fetch,
	{
		refresh = false,
		signal,
		timeoutMs = 8000
	}: { refresh?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ data: T; savedAt: string | null }> {
	signal?.throwIfAborted();
	let cache: Cache | undefined;
	let saved: { data: T; savedAt: string | null } | undefined;
	try {
		cache = await caches.open('dashboard-data-v1');
		const response = await cache.match(url);
		if (response)
			saved = { data: await response.json(), savedAt: response.headers.get('x-saved-at') };
	} catch {
		/* Storage may be disabled or full. Online reads must still work. */
	}
	const unavailable = () =>
		new Error(
			saved
				? 'Could not refresh while offline. Your previous data is still shown.'
				: 'No saved data is available. Check your connection, then reload to try again.'
		);
	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		if (saved && !refresh) return saved;
		throw unavailable();
	}
	const controller = new AbortController();
	const fetchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	let timeout: ReturnType<typeof setTimeout>;
	const network = Promise.race([
		(async () => {
			const response = await request(url, {
				cache: 'no-store',
				redirect: 'error',
				signal: fetchSignal
			});
			if (
				!response.ok ||
				response.redirected ||
				!response.headers.get('content-type')?.includes('application/json')
			) {
				throw new Error('Could not refresh. Check your connection or use Reconnect to sign in.', {
					cause: response.status
				});
			}
			const data = (await response.json()) as T;
			fetchSignal.throwIfAborted();
			// Parse before storing: an incomplete transfer or login page must not replace good data.
			if (!fetchSignal.aborted)
				await cache
					?.put(
						url,
						new Response(JSON.stringify(data), {
							headers: {
								'content-type': 'application/json',
								'x-saved-at': new Date().toISOString()
							}
						})
					)
					.catch(() => {});
			return { data, savedAt: null };
		})(),
		new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				controller.abort();
				reject(unavailable());
			}, timeoutMs);
		})
	]).finally(() => clearTimeout(timeout));
	if (!saved || refresh) return network;
	let fallback: ReturnType<typeof setTimeout>;
	return Promise.race([
		network.catch(() => {
			signal?.throwIfAborted();
			return saved!;
		}),
		new Promise<typeof saved>((resolve) => {
			fallback = setTimeout(() => resolve(saved), 750);
		})
	]).finally(() => clearTimeout(fallback)) as Promise<{ data: T; savedAt: string | null }>;
}
