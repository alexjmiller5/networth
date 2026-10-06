import { describe, expect, it } from 'vitest';
import vectors from './run-contract.golden.json';
import {
	canonicalDecisionRequest,
	decisionRequestDigest,
	parseLaunchRequest,
	parseClaimRequest,
	parseStartRequest,
	parseEventDecision,
	canonicalLaunchRequest,
	launchRequestDigest,
	isStartReady,
	type RunControl
} from './run-contract';

const launch = {
	request_id: 'request-1',
	action: 'finance-review',
	account_ids: ['account-b', 'account-a'],
	tracking_task_ids: ['task-1']
};

describe('finance run request boundaries', () => {
	it('preserves opaque IDs while rejecting command or policy injection', () => {
		expect(parseLaunchRequest(launch)).toEqual(launch);
		for (const field of ['command', 'model', 'environment', 'host_id', 'principal']) {
			expect(() => parseLaunchRequest({ ...launch, [field]: 'injected' })).toThrow();
		}
	});
	it.each([
		{ ...launch, action: 'shell' },
		{ ...launch, account_ids: ['account-a', 'account-a'] },
		{ ...launch, account_ids: [] },
		{ ...launch, account_ids: ['\ud800'] },
		{ ...launch, account_ids: ['x\n'] },
		{ ...launch, tracking_task_ids: [] },
		{ ...launch, request_id: ' ' }
	])('rejects invalid scope or identity %#', (value) => {
		expect(() => parseLaunchRequest(value)).toThrow();
	});
	it('bounds long polling and keeps claim retry identity explicit', () => {
		expect(parseClaimRequest({ request_id: 'poll-1', wait_seconds: 25 })).toEqual({
			request_id: 'poll-1',
			wait_seconds: 25
		});
		for (const wait_seconds of [-1, 26, 0.5, Infinity, '25']) {
			expect(() => parseClaimRequest({ request_id: 'poll-1', wait_seconds })).toThrow();
		}
		expect(() => parseClaimRequest({ wait_seconds: 1 })).toThrow();
	});
	it('requires a distinct instruction identity, opaque lease and exact safe revision', () => {
		expect(
			parseStartRequest({
				instruction_id: 'instruction-1',
				expected_revision: 0,
				lease_generation: 'lease-1'
			})
		).toEqual({
			instruction_id: 'instruction-1',
			expected_revision: 0,
			lease_generation: 'lease-1'
		});
		for (const expected_revision of [-0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() =>
				parseStartRequest({
					instruction_id: 'instruction-1',
					expected_revision,
					lease_generation: 'lease-1'
				})
			).toThrow();
		}
		expect(() =>
			parseStartRequest({ request_id: 'poll-1', expected_revision: 0, lease_generation: 'lease-1' })
		).toThrow();
	});
});

describe('canonical scope identity', () => {
	it('sorts scope by UTF-8 bytes without changing opaque identities or input arrays', async () => {
		expect(canonicalLaunchRequest(launch)).toBe(
			'{"action":"finance-review","account_ids":["account-a","account-b"],"tracking_task_ids":["task-1"]}'
		);
		expect(await launchRequestDigest(launch)).toBe(
			await launchRequestDigest({
				...launch,
				request_id: 'another-request',
				account_ids: ['account-a', 'account-b']
			})
		);
		expect(await launchRequestDigest(launch)).not.toBe(
			await launchRequestDigest({ ...launch, account_ids: ['account-a'] })
		);
		expect(launch.account_ids).toEqual(['account-b', 'account-a']);
		expect(canonicalLaunchRequest({ ...launch, account_ids: ['\u{10000}', '\ue000'] })).toContain(
			'["\ue000","\u{10000}"]'
		);
	});
});

describe('durable event outcomes', () => {
	const rejected = {
		event_id: 'event-7',
		lease_generation: 'lease-1',
		sequence: 7,
		consumed_sequence: 7,
		decision_digest: 'a'.repeat(64),
		revision: 11,
		outcome: 'rejected_not_applied',
		reason: 'revision_conflict'
	};
	it('represents consumed rejection independently of domain revision', () => {
		expect(parseEventDecision(rejected)).toEqual(rejected);
		expect(parseEventDecision({ ...rejected, outcome: 'applied', reason: null })).toMatchObject({
			outcome: 'applied',
			revision: 11
		});
	});
	it.each([
		{ ...rejected, consumed_sequence: 6 },
		{ ...rejected, outcome: 'locally_retained' },
		{ ...rejected, outcome: 'applied' },
		{ ...rejected, reason: null },
		{ ...rejected, decision_digest: 'not-a-digest' },
		{ ...rejected, next_sequence: 8 }
	])('does not mistake malformed or local ACKs for durable outcomes %#', (value) => {
		expect(() => parseEventDecision(value)).toThrow();
	});
});

function readyControl(): RunControl {
	const verified = {
		state: 'verified' as const,
		evidence_ref: 'proof-1',
		checked_at: '2030-01-01T00:00:00.000Z'
	};
	return {
		run_id: 'run-1',
		host_id: 'host-1',
		lease_generation: 'lease-1',
		revision: 2,
		account_ids: ['account-a'],
		tracking_task_ids: ['task-1'],
		domain_id: 'domain-1',
		cancellation: 'none',
		capture_closed: false,
		transport: 'ready',
		collection: 'not_started',
		review: 'not_started',
		reservation: 'held',
		eligibility: { state: 'eligible', checked_at: '2030-01-01T00:00:00.000Z' },
		readiness: {
			native_identity: verified,
			user_reachability: verified,
			collector_context: verified,
			source_controls: verified
		},
		start_instruction_id: null,
		next_sequence: 1
	};
}

describe('start prerequisites', () => {
	it('requires every independent readiness proof', () => {
		expect(isStartReady(readyControl())).toBe(true);
		for (const gate of [
			'native_identity',
			'user_reachability',
			'collector_context',
			'source_controls'
		] as const) {
			const control = readyControl();
			control.readiness[gate] = { state: 'unavailable', reason: 'not_verified' };
			expect(isStartReady(control)).toBe(false);
		}
	});
	it('cannot turn cancelled, already-started, released or ineligible runs into new starts', () => {
		for (const patch of [
			{ cancellation: 'requested' },
			{ cancellation: 'acknowledged' },
			{ capture_closed: true },
			{ reservation: 'released' },
			{ collection: 'running' },
			{ transport: 'recovery_required' },
			{ start_instruction_id: 'instruction-1' },
			{ eligibility: { state: 'drifted', checked_at: null } }
		]) {
			expect(isStartReady({ ...readyControl(), ...patch } as RunControl)).toBe(false);
		}
	});
});

describe('cross-language original-request digest', () => {
	it.each(vectors)('matches Python golden vector $name', async ({ request, canonical, sha256 }) => {
		expect(canonicalDecisionRequest(request)).toBe(canonical);
		expect(await decisionRequestDigest(request)).toBe(sha256);
		expect(await decisionRequestDigest({ ...request, lease_generation: 'another-lease' })).not.toBe(
			sha256
		);
	});
	it('sorts every object by UTF-8 key bytes and preserves array order', () => {
		expect(
			canonicalDecisionRequest({ '10': 1, '2': 2, nested: { '𐀀': 0, '': 1 }, list: [2, 1] })
		).toBe('{"10":1,"2":2,"list":[2,1],"nested":{"":1,"𐀀":0}}');
	});
	it.each([0.5, NaN, Infinity, 9007199254740992, -0, undefined, new Date(), '\ud800'])(
		'rejects noncanonical input %#',
		(value) => {
			expect(() => canonicalDecisionRequest({ payload: value })).toThrow();
		}
	);
});

it('preserves leading Unicode BOM in opaque IDs and canonical keys/values', () => {
	expect(parseLaunchRequest({ ...launch, request_id: '\ufeffrequest-1' }).request_id).toBe(
		'\ufeffrequest-1'
	);
	expect(canonicalDecisionRequest({ '\ufeffkey': '\ufeffvalue' })).toBe(
		'{"\ufeffkey":"\ufeffvalue"}'
	);
});
