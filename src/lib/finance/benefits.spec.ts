import { describe, expect, it } from 'vitest';
import {
	assembleBenefits,
	benefitMoney,
	readBenefitPrivacy,
	writeBenefitPrivacy
} from './benefits';

const plan = (overrides: Record<string, unknown> = {}) => ({
	id: 'plan-1',
	provider: 'Example Benefits',
	native_plan_id: 'native-1',
	name: 'Health plan',
	kind: 'fsa',
	currency: 'USD',
	status: 'active',
	...overrides
});
const observation = (overrides: Record<string, unknown> = {}) => ({
	id: 'observation-1',
	plan_id: 'plan-1',
	plan_year: 2024,
	observed_at: '2024-04-06T12:00:00.000Z',
	source_as_of: '2024-04-05',
	currency: 'USD',
	annual_election: 800,
	employee_contributions: 125.5,
	claims_submitted: 300,
	claims_paid: 180,
	claims_denied: 30,
	available_benefit: 0,
	stated_notional_balance: null,
	vested_balance: null,
	eligibility_status: 'Conditional credit of 999.99 is not vested',
	vested_visibility: 'not_exposed',
	source_record_ref: 'private-evidence/record-1',
	...overrides
});

describe('native benefit read model', () => {
	it('preserves independent stated values and explicit zero without arithmetic or transaction totals', () => {
		const model = assembleBenefits([plan()], [observation()]);
		expect(model.plans[0].years[0].observations[0]).toMatchObject({
			annual_election: 800,
			employee_contributions: 125.5,
			claims_submitted: 300,
			claims_paid: 180,
			claims_denied: 30,
			available_benefit: 0,
			stated_notional_balance: null,
			vested_balance: null,
			source_as_of: '2024-04-05',
			observed_at: '2024-04-06T12:00:00.000Z'
		});
		expect(JSON.stringify(model)).not.toMatch(
			/source_record_ref|private-evidence|transactions|netWorth/
		);
	});
	it('groups plan years and orders source date before capture time, with undated sources last', () => {
		const model = assembleBenefits(
			[plan()],
			[
				observation(),
				observation({
					id: 'old-recapture',
					source_as_of: '2024-04-01',
					observed_at: '2024-06-01T12:00:00.000Z'
				}),
				observation({
					id: 'unknown-source',
					source_as_of: null,
					observed_at: '2024-07-01T12:00:00.000Z'
				}),
				observation({ id: 'prior-year', plan_year: 2023 }),
				observation({ id: 'same-source', observed_at: '2024-04-07T12:00:00.000Z' })
			]
		);
		expect(model.plans[0].years.map((y) => y.year)).toEqual([2024, 2023]);
		expect(model.plans[0].years[0].observations.map((o) => o.id)).toEqual([
			'same-source',
			'observation-1',
			'old-recapture',
			'unknown-source'
		]);
	});
	it('retains unknown plan year and suppressed vested amounts without deriving them from credit', () => {
		const model = assembleBenefits(
			[plan({ kind: 'retiree_health' })],
			[
				observation({
					plan_year: null,
					vested_visibility: 'suppressed',
					stated_notional_balance: 0,
					annual_election: null
				})
			]
		);
		expect(model.plans[0].years[0]).toMatchObject({
			year: null,
			observations: [
				{
					vested_visibility: 'suppressed',
					vested_balance: null,
					stated_notional_balance: 0,
					annual_election: null
				}
			]
		});
	});
	it('keeps plans with no observations visible and omits soft-deleted records', () => {
		const model = assembleBenefits(
			[plan(), plan({ id: 'deleted', deleted_at: '2024-01-01' })],
			[observation({ deleted_at: '2024-01-01' })]
		);
		expect(model.plans).toHaveLength(1);
		expect(model.plans[0].years).toEqual([]);
	});
	it.each([
		{ observed_at: '2024-02-30T00:00:00Z' },
		{ source_as_of: '2024-02-30' },
		{ observed_at: '2024-04-05' },
		{ currency: 'EUR' },
		{ annual_election: '' },
		{ annual_election: '1e3' },
		{ annual_election: Infinity },
		{ plan_id: 'unknown' },
		{ source_record_ref: '' },
		{ vested_visibility: 'suppressed', vested_balance: 20 },
		{ plan_year: 2024.5 }
	])('rejects malformed or contradictory observations', (invalid) => {
		expect(() => assembleBenefits([plan()], [observation(invalid)])).toThrow();
	});
	it('rejects duplicate identities and invalid plans instead of silently replacing evidence', () => {
		expect(() => assembleBenefits([plan(), plan()], [observation()])).toThrow();
		expect(() => assembleBenefits([plan()], [observation(), observation()])).toThrow();
		for (const invalid of [{ currency: 'ZZZ' }, { kind: 'cash' }, { provider: '' }, { name: '' }])
			expect(() => assembleBenefits([plan(invalid)], [])).toThrow();
	});
	it('allows strict decimal strings and missing metrics while rejecting extra public evidence fields', () => {
		const row = observation({
			employee_contributions: '12.34',
			claims_denied: undefined,
			raw_evidence: 'secret'
		});
		const result = assembleBenefits([plan({ private_locator: 'private' })], [row]);
		expect(result.plans[0].years[0].observations[0]).toMatchObject({
			employee_contributions: 12.34,
			claims_denied: null
		});
		expect(JSON.stringify(result)).not.toContain('private');
		expect(JSON.stringify(result)).not.toContain('secret');
	});
});

describe('benefit amount presentation and shared privacy preference', () => {
	it('distinguishes unavailable, zero, hidden, and native currency', () => {
		expect(benefitMoney(null, 'USD', false)).toBe('Not reported');
		expect(benefitMoney(0, 'USD', false)).toBe('$0.00');
		expect(benefitMoney(12.34, 'EUR', false)).toBe('€12.34');
		expect(benefitMoney(12.34, 'USD', true)).toBe('Hidden');
	});
	it('restores concealment before rendering and changes only its saved field', () => {
		let value = JSON.stringify({
			hideAmounts: true,
			activePreset: 'ALL',
			hidden: { account: ['account-1'] },
			futureField: 12
		});
		const storage = {
			getItem: () => value,
			setItem: (_key: string, next: string) => {
				value = next;
			}
		};
		expect(readBenefitPrivacy(storage)).toBe(true);
		writeBenefitPrivacy(storage, false);
		expect(JSON.parse(value)).toEqual({
			hideAmounts: false,
			activePreset: 'ALL',
			hidden: { account: ['account-1'] },
			futureField: 12
		});
	});
	it('tolerates blocked or malformed storage', () => {
		expect(readBenefitPrivacy({ getItem: () => '{broken' })).toBe(false);
		expect(readBenefitPrivacy({ getItem: () => '{"hideAmounts":"true"}' })).toBe(false);
		expect(() => writeBenefitPrivacy(undefined, true)).not.toThrow();
	});
});
