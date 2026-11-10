import { expect, it } from 'vitest';
import { boundedBody } from './bounded-body';

it('cancels an oversized chunk before retention and never consumes later chunks', async () => {
	let pulls = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(c) {
				pulls++;
				c.enqueue(new Uint8Array(pulls === 1 ? 11 : 1));
				if (pulls === 3) c.close();
			},
			cancel() {
				cancelled = true;
			}
		},
		{ highWaterMark: 0 }
	);
	const decode = TextDecoder.prototype.decode;
	let decodedBytes = 0;
	TextDecoder.prototype.decode = function (input, options) {
		decodedBytes += input?.byteLength ?? 0;
		return decode.call(this, input, options);
	};
	try {
		await expect(boundedBody(new Response(stream), 10)).rejects.toThrow('Trip stream read limit');
	} finally {
		TextDecoder.prototype.decode = decode;
	}
	expect(decodedBytes).toBe(0);
	expect(cancelled).toBe(true);
	expect(pulls).toBe(1);
	expect(stream.locked).toBe(false);
});

it('counts raw bytes across a split UTF-8 sequence and accepts the exact remaining budget', async () => {
	const bytes = new TextEncoder().encode('"café"');
	const split = bytes.indexOf(0xc3) + 1;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(bytes.slice(0, split));
			c.enqueue(bytes.slice(split));
			c.close();
		}
	});
	expect(await boundedBody(new Response(stream), bytes.length)).toEqual({
		text: '"café"',
		bytes: bytes.length
	});
	expect(stream.locked).toBe(false);
});

it('cancels malformed UTF-8 without consuming later chunks', async () => {
	let pulls = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(c) {
				pulls++;
				c.enqueue(pulls === 1 ? new Uint8Array([0xff]) : new Uint8Array([32]));
				if (pulls === 3) c.close();
			},
			cancel() {
				cancelled = true;
			}
		},
		{ highWaterMark: 0 }
	);
	await expect(boundedBody(new Response(stream), 10)).rejects.toThrow();
	expect(cancelled).toBe(true);
	expect(pulls).toBe(1);
	expect(stream.locked).toBe(false);
});

it('rejects an incomplete UTF-8 sequence and propagates stream failure', async () => {
	await expect(boundedBody(new Response(new Uint8Array([0xc3])), 10)).rejects.toThrow();
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.error(Error('source failed'));
		}
	});
	await expect(boundedBody(new Response(stream), 10)).rejects.toThrow('source failed');
	expect(stream.locked).toBe(false);
});

it('enforces the cumulative remaining budget and preserves the limit error if cancellation fails', async () => {
	let pulls = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(c) {
				pulls++;
				c.enqueue(new Uint8Array(6));
				if (pulls === 3) c.close();
			},
			cancel() {
				cancelled = true;
				throw Error('cancel failed');
			}
		},
		{ highWaterMark: 0 }
	);
	await expect(boundedBody(new Response(stream), 10)).rejects.toThrow('Trip stream read limit');
	expect(pulls).toBe(2);
	expect(cancelled).toBe(true);
	expect(stream.locked).toBe(false);
});
