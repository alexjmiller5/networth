/** Read one response against the remaining aggregate byte budget. */
export async function boundedBody(response: Response, remaining: number) {
	const reader = response.body?.getReader();
	if (!reader) return { text: '', bytes: 0 };
	const decoder = new TextDecoder('utf-8', { fatal: true });
	const parts: string[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.byteLength > remaining - bytes) throw Error('Trip stream read limit');
			bytes += value.byteLength;
			parts.push(decoder.decode(value, { stream: true }));
		}
		parts.push(decoder.decode());
		return { text: parts.join(''), bytes };
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}
