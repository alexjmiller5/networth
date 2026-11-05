import config from '../../../wrangler.jsonc?raw';
import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

it('delivers the configured public URL as a variable and keeps runtime credentials on stdin', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'url-delivery-'));
	try {
		await writeFile(
			join(dir, 'op'),
			'#!/bin/bash\nwhile [[ "$1" != -- ]]; do shift; done\nshift\nexec "$@"\n',
			{ mode: 0o700 }
		);
		await writeFile(
			join(dir, 'bunx'),
			'#!/bin/bash\nprintf "%s\\n" "$@" > "$RECEIPT.args"\ncat > "$RECEIPT.stdin"\n',
			{ mode: 0o700 }
		);
		const receipt = join(dir, 'receipt');
		const result = spawnSync('bash', ['scripts/sync-secrets.sh', '--deploy'], {
			env: {
				...process.env,
				PATH: dir + ':' + process.env.PATH,
				SOMA_HUB_URL: 'https://hub.test',
				SOMA_HUB_TOKEN: 'test-token',
				TIINGO_API_KEY: 'test-prices',
				RECEIPT: receipt
			},
			encoding: 'utf8',
			timeout: 10000
		});
		expect(result.status, result.stderr).toBe(0);
		const args = await readFile(receipt + '.args', 'utf8');
		const stdin = await readFile(receipt + '.stdin', 'utf8');
		expect(args).toContain('--var\nSOMA_HUB_URL:https://hub.test');
		expect(args).not.toContain('test-token');
		expect(stdin).toContain('SOMA_HUB_TOKEN=test-token');
		expect(stdin).not.toContain('SOMA_HUB_URL=');
		expect(config).not.toMatch(/"SOMA_HUB_URL"\s*:/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
