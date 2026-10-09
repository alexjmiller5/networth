import { expect, it } from 'vitest';
import { parseAccountIds, parseHostPatch } from './run-contract';

it('accepts registry-shaped account ids and rejects anything that could reshape the instruction', () => {
	expect(parseAccountIds(['cash', 'bofa-checking'])).toEqual(['cash', 'bofa-checking']);
	for (const bad of [[], ['cash', 'cash'], ['Cash'], ['cash; rm -rf ~'], ["a'b"], 'cash', [1]])
		expect(parseAccountIds(bad)).toBeNull();
	expect(parseAccountIds(Array.from({ length: 101 }, (_, i) => `a${i}`))).toBeNull();
});
it('accepts only known host report fields with bounded values', () => {
	expect(parseHostPatch({ status: 'running', agent_name: 'finance-run-1a2b3c4d' })).toEqual({
		status: 'running',
		agent_name: 'finance-run-1a2b3c4d'
	});
	for (const bad of [
		{},
		{ status: 'queued' },
		{ status: 'claimed' },
		{ host_id: 'other' },
		{ agent_kind: 'gpt' },
		{ agent_name: 'Bad Name' },
		{ summary: 'line\nbreak' },
		{ summary: 'x'.repeat(1001) }
	])
		expect(parseHostPatch(bad)).toBeNull();
});
