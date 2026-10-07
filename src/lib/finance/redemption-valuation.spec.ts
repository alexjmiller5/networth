import { describe, expect, it } from 'vitest';
import {
	calculateRedemptionValuation,
	type RedemptionValuationInput
} from './redemption-valuation';

function input(): RedemptionValuationInput {
	return {
		event: {
			id: 'event-1',
			component_id: 'component-1',
			kind: 'redeem',
			state: 'posted',
			event_date: '2025-02-03',
			units_delta: '-3',
			receipt: null
		},
		component: {
			id: 'component-1',
			program_id: 'program-1',
			unit: 'points',
			role: 'redeemable',
			currency: null
		},
		selection: {
			basis: 'user_override',
			comparable_amount: '20',
			currency: 'USD',
			comparable_scope: 'reward_funded_portion',
			units_consumed: '3',
			deducted_leg_ids: [],
			estimate_term_id: null
		},
		evidence: {
			comparable_amount: '20',
			estimate_term_id: null,
			event_id: 'event-1',
			component_id: 'component-1',
			unit: 'points',
			role: 'redeemable',
			currency: 'USD',
			comparable_scope: 'reward_funded_portion',
			method_key: null,
			authority: 'user',
			applicability: 'owner_confirmed',
			reference: 'evidence-1',
			source_amount_scope_rule: null,
			cost_coverage_reference: null
		},
		context: { event_head_id: 'event-1', chain_verified: true, method_key: null },
		estimate_term: null,
		valued_at: '2025-03-01T12:00:00.000Z'
	};
}
function gross(): RedemptionValuationInput {
	const value = input();
	value.selection.comparable_scope = 'gross_benefit';
	value.selection.comparable_amount = value.evidence.comparable_amount = '300';
	value.selection.deducted_leg_ids = ['cash', 'fee'];
	value.evidence.comparable_scope = 'gross_benefit';
	value.evidence.cost_coverage_reference = 'cost-evidence';
	value.event.receipt = {
		money_legs: [
			{ id: 'cash', role: 'cash_paid', amount: '50', currency: 'USD', included_in: null },
			{ id: 'fee', role: 'fee', amount: '10', currency: 'USD', included_in: null }
		],
		out_of_pocket: {
			coverage: 'complete',
			authority: 'provider',
			leg_ids: ['cash', 'fee'],
			method_key: null
		}
	};
	return value;
}
function estimate(): RedemptionValuationInput {
	const value = input();
	value.selection.basis = 'estimate';
	value.selection.estimate_term_id = value.evidence.estimate_term_id = 'term-1';
	value.selection.comparable_amount = value.evidence.comparable_amount = '0.375';
	value.estimate_term = {
		id: 'term-1',
		program_id: 'program-1',
		component_id: 'component-1',
		kind: 'valuation_estimate',
		authority: 'user',
		applicability: 'owner_confirmed',
		effective_from: '2025-01-01',
		effective_until: '2026-01-01',
		payload: {
			schema_version: 1,
			component_id: 'component-1',
			method_key: null,
			currency: 'USD',
			value_per_unit: '0.125',
			convention: 'Approved synthetic convention',
			conditions: []
		}
	};
	return value;
}

describe('exact frozen redemption values', () => {
	it('preserves exact rational inputs and rounds only the display division', () => {
		const result = calculateRedemptionValuation(input());
		expect(result).toMatchObject({
			event_id: 'event-1',
			basis: 'user_override',
			comparable_amount: '20',
			reward_value: '20',
			units_consumed: '3',
			rate_at_redemption: '6.666666666666666667',
			rate_scale: 18,
			rate_rounding: 'half_even',
			calculation_version: 'redemption-valuation-v1',
			valued_at: '2025-03-01T12:00:00.000Z'
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.deducted_leg_ids)).toBe(true);
	});
	it('subtracts exact decimal costs, not binary floats', () => {
		const value = gross();
		value.selection.comparable_amount = value.evidence.comparable_amount = '0.3';
		value.event.receipt!.money_legs[0].amount = '0.1';
		value.event.receipt!.money_legs[1].amount = '0.2';
		expect(calculateRedemptionValuation(value)).toMatchObject({
			reward_value: '0',
			rate_at_redemption: '0'
		});
	});
	it('preserves values above the safe integer boundary without numeric coercion', () => {
		const value = input();
		value.selection.comparable_amount = value.evidence.comparable_amount =
			'9007199254740993.1234567890123456789';
		value.event.units_delta = '-1';
		value.selection.units_consumed = '1';
		expect(calculateRedemptionValuation(value)).toMatchObject({
			reward_value: '9007199254740993.1234567890123456789',
			rate_at_redemption: '9007199254740993.123456789012345679'
		});
	});
	it.each([
		['0.0000000000000000005', '0'],
		['0.0000000000000000015', '0.000000000000000002'],
		['0.0000000000000000025', '0.000000000000000002'],
		['0.9999999999999999995', '1']
	])('rounds %s HALF_EVEN at exactly eighteen decimal places', (amount, expected) => {
		const value = input();
		value.selection.comparable_amount = value.evidence.comparable_amount = amount;
		value.event.units_delta = '-1';
		value.selection.units_consumed = '1';
		expect(calculateRedemptionValuation(value).rate_at_redemption).toBe(expected);
	});
	it.each([
		'00',
		'+1',
		'-0',
		'0.0',
		'1.20',
		'.1',
		'1e2',
		' 1',
		'1 ',
		'NaN',
		'1'.repeat(101),
		'0.' + '0'.repeat(50) + '1'
	])('rejects noncanonical or oversized input %s', (amount) => {
		const value = input();
		value.selection.comparable_amount = value.evidence.comparable_amount = amount;
		expect(() => calculateRedemptionValuation(value)).toThrow();
	});
	it('does not round an out-of-bounds exact product into the contract', () => {
		const value = estimate();
		value.event.units_delta = '-' + '9'.repeat(100);
		value.selection.units_consumed = '9'.repeat(100);
		value.estimate_term!.payload.value_per_unit = '9'.repeat(100);
		expect(() => calculateRedemptionValuation(value)).toThrow();
	});
});

describe('authoritative complete cost deductions', () => {
	it('deducts the whole disjoint set and freezes sorted identities', () => {
		const value = gross();
		value.selection.deducted_leg_ids.reverse();
		const result = calculateRedemptionValuation(value);
		expect(result).toMatchObject({
			reward_value: '240',
			rate_at_redemption: '80',
			deducted_leg_ids: ['cash', 'fee']
		});
		value.event.receipt!.money_legs[0].amount = '90';
		value.selection.deducted_leg_ids.push('later');
		expect(result.reward_value).toBe('240');
		expect(result.deducted_leg_ids).toEqual(['cash', 'fee']);
	});
	it.each([
		'subset',
		'extra',
		'duplicate',
		'partial',
		'unknown',
		'authority',
		'currency',
		'missing-leg',
		'overlap',
		'cycle',
		'zero-leg',
		'negative-result',
		'method',
		'missing-evidence'
	])('rejects %s instead of inventing net value', (problem) => {
		const value = gross();
		const receipt = value.event.receipt!;
		if (problem === 'subset') value.selection.deducted_leg_ids = ['cash'];
		if (problem === 'extra') value.selection.deducted_leg_ids.push('other');
		if (problem === 'duplicate') receipt.out_of_pocket.leg_ids.push('cash');
		if (problem === 'partial' || problem === 'unknown') receipt.out_of_pocket.coverage = problem;
		if (problem === 'authority') receipt.out_of_pocket.authority = 'unknown';
		if (problem === 'currency') receipt.money_legs[1].currency = 'EUR';
		if (problem === 'missing-leg') receipt.money_legs.pop();
		if (problem === 'overlap') receipt.money_legs[1].included_in = 'cash';
		if (problem === 'cycle') {
			receipt.money_legs[0].included_in = 'fee';
			receipt.money_legs[1].included_in = 'cash';
		}
		if (problem === 'zero-leg') receipt.money_legs[0].amount = '0';
		if (problem === 'negative-result')
			value.selection.comparable_amount = value.evidence.comparable_amount = '1';
		if (problem === 'method') receipt.out_of_pocket.method_key = 'different';
		if (problem === 'missing-evidence') value.evidence.cost_coverage_reference = null;
		expect(() => calculateRedemptionValuation(value)).toThrow();
	});
	it('allows an evidenced total once, excluding its included child from deductions', () => {
		const value = gross();
		value.event.receipt!.money_legs[1].included_in = 'cash';
		value.event.receipt!.out_of_pocket.leg_ids = ['cash'];
		value.selection.deducted_leg_ids = ['cash'];
		expect(calculateRedemptionValuation(value).reward_value).toBe('250');
	});
	it('allows explicit complete zero costs without manufacturing zero from an absent receipt', () => {
		const value = gross();
		value.event.receipt!.out_of_pocket.leg_ids = [];
		value.event.receipt!.money_legs = [
			{ id: 'cash', role: 'cash_paid', amount: '0', currency: 'USD', included_in: null }
		];
		value.selection.deducted_leg_ids = [];
		expect(calculateRedemptionValuation(value).reward_value).toBe('300');
		value.event.receipt = null;
		expect(() => calculateRedemptionValuation(value)).toThrow();
	});
	it('uses an explicit reward-funded amount without requiring or subtracting incomplete costs', () => {
		const value = gross();
		value.selection.comparable_scope = value.evidence.comparable_scope = 'reward_funded_portion';
		value.selection.comparable_amount = value.evidence.comparable_amount = '240';
		value.selection.deducted_leg_ids = [];
		value.event.receipt!.out_of_pocket.coverage = 'unknown';
		expect(calculateRedemptionValuation(value).reward_value).toBe('240');
		value.selection.deducted_leg_ids = ['cash'];
		expect(() => calculateRedemptionValuation(value)).toThrow();
	});
});

describe('event, component, and selected basis evidence', () => {
	it.each([
		'pending',
		'earn',
		'positive',
		'zero',
		'unknown-units',
		'units-mismatch',
		'component',
		'unit',
		'qualifying',
		'currency',
		'missing-proof',
		'unapproved',
		'head',
		'fork'
	])('rejects %s', (problem) => {
		const value = input();
		if (problem === 'pending') value.event.state = 'pending';
		if (problem === 'earn') value.event.kind = 'earn';
		if (problem === 'positive') value.event.units_delta = '3';
		if (problem === 'zero') value.event.units_delta = '0';
		if (problem === 'unknown-units') value.event.units_delta = null;
		if (problem === 'units-mismatch') value.selection.units_consumed = '2';
		if (problem === 'component') value.component.id = 'other';
		if (problem === 'unit') value.evidence.unit = 'miles';
		if (problem === 'qualifying') value.component.role = value.evidence.role = 'qualifying';
		if (problem === 'currency') value.component.currency = 'EUR';
		if (problem === 'missing-proof') value.evidence.reference = '';
		if (problem === 'unapproved') value.evidence.applicability = 'public_unverified';
		if (problem === 'head') value.context.event_head_id = 'other';
		if (problem === 'fork') value.context.chain_verified = false;
		expect(() => calculateRedemptionValuation(value)).toThrow();
	});
	it('requires a provider amount/scope rule instead of treating receipt gross as comparable', () => {
		const value = input();
		value.selection.basis = 'provider_comparable';
		value.evidence.authority = 'provider';
		value.evidence.applicability = 'account_observed';
		expect(() => calculateRedemptionValuation(value)).toThrow();
		value.evidence.source_amount_scope_rule = 'rule-evidence';
		expect(calculateRedemptionValuation(value).reward_value).toBe('20');
	});
	it('allows a matched native currency component without conversion', () => {
		const value = input();
		value.component.unit = value.evidence.unit = 'USD';
		value.component.currency = 'USD';
		value.component.role = value.evidence.role = 'cash_reward';
		expect(calculateRedemptionValuation(value).units_consumed).toBe('3');
	});
	it('freezes the selected approved estimate version and exact product', () => {
		const value = estimate();
		const result = calculateRedemptionValuation(value);
		expect(result).toMatchObject({
			basis: 'estimate',
			estimate_term_id: 'term-1',
			reward_value: '0.375',
			rate_at_redemption: '0.125'
		});
		value.estimate_term!.payload.value_per_unit = '2';
		expect(result.reward_value).toBe('0.375');
	});
	it.each([
		'unapproved',
		'provider',
		'version',
		'component',
		'program',
		'currency',
		'future',
		'expired',
		'undated',
		'method',
		'conditions',
		'amount',
		'gross'
	])('rejects an estimate with %s evidence', (problem) => {
		const value = estimate();
		const term = value.estimate_term!;
		if (problem === 'unapproved') term.applicability = 'public_unverified';
		if (problem === 'provider') term.authority = 'provider';
		if (problem === 'version') term.id = 'other';
		if (problem === 'component') term.payload.component_id = 'other';
		if (problem === 'program') term.program_id = 'other';
		if (problem === 'currency') term.payload.currency = 'EUR';
		if (problem === 'future') term.effective_from = '2025-02-04';
		if (problem === 'expired') term.effective_until = '2025-02-03';
		if (problem === 'undated') term.effective_from = null;
		if (problem === 'method') term.payload.method_key = 'different';
		if (problem === 'conditions') term.payload.conditions = ['Unresolved condition'];
		if (problem === 'amount')
			value.selection.comparable_amount = value.evidence.comparable_amount = '0.4';
		if (problem === 'gross') value.selection.comparable_scope = 'gross_benefit';
		expect(() => calculateRedemptionValuation(value)).toThrow();
	});
});

it('binds comparable value approval to the exact selected amount', () => {
	const value = input();
	value.selection.comparable_amount = '21';
	expect(() => calculateRedemptionValuation(value)).toThrow();
});
it('binds estimate approval to the exact selected term version', () => {
	const value = estimate();
	value.selection.estimate_term_id = value.estimate_term!.id = 'another-version';
	expect(() => calculateRedemptionValuation(value)).toThrow();
});

it('rejects a currency unit with missing currency metadata', () => {
	const value = input();
	value.component.unit = value.evidence.unit = 'USD';
	expect(() => calculateRedemptionValuation(value)).toThrow();
});
it('keeps the selected override when an unselected estimate is available', () => {
	const value = input();
	value.estimate_term = estimate().estimate_term;
	expect(calculateRedemptionValuation(value)).toMatchObject({
		basis: 'user_override',
		reward_value: '20',
		estimate_term_id: null
	});
});
it('divides fractional native units exactly', () => {
	const value = input();
	value.event.units_delta = '-0.3';
	value.selection.units_consumed = '0.3';
	value.selection.comparable_amount = value.evidence.comparable_amount = '0.1';
	expect(calculateRedemptionValuation(value).rate_at_redemption).toBe('0.333333333333333333');
});
it('supports canonical bounds without truncating exact inputs', () => {
	const value = input();
	value.event.units_delta = '-1';
	value.selection.units_consumed = '1';
	for (const amount of ['1'.repeat(100), '0.' + '0'.repeat(49) + '1']) {
		value.selection.comparable_amount = value.evidence.comparable_amount = amount;
		expect(calculateRedemptionValuation(value).reward_value).toBe(amount);
	}
});
it('does not permit a complete canonical set to omit explicitly paid cash', () => {
	const value = gross();
	value.event.receipt!.out_of_pocket.leg_ids = value.selection.deducted_leg_ids = ['fee'];
	expect(() => calculateRedemptionValuation(value)).toThrow();
});
it.each(['duplicate-leg', 'missing-ancestor', 'noncost', 'other-currency'])(
	'rejects invalid receipt structure: %s',
	(problem) => {
		const value = gross();
		const receipt = value.event.receipt!;
		if (problem === 'duplicate-leg') receipt.money_legs.push({ ...receipt.money_legs[0] });
		if (problem === 'missing-ancestor') receipt.money_legs[0].included_in = 'missing';
		if (problem === 'noncost') receipt.money_legs[0].role = 'face_value';
		if (problem === 'other-currency')
			receipt.money_legs.push({
				id: 'gross',
				role: 'purchase_gross',
				amount: '500',
				currency: 'EUR',
				included_in: null
			});
		expect(() => calculateRedemptionValuation(value)).toThrow();
	}
);
it('supports an explicitly effective open-ended estimate without using capture time', () => {
	const value = estimate();
	value.estimate_term!.effective_until = null;
	value.estimate_term!.effective_from = value.event.event_date;
	expect(calculateRedemptionValuation(value).reward_value).toBe('0.375');
	value.event.event_date = null;
	expect(() => calculateRedemptionValuation(value)).toThrow();
});
it.each(['2025-02-30T00:00:00.000Z', '2025-03-01', '2025-03-01T12:00:00-05:00'])(
	'rejects invalid assertion time %s',
	(valuedAt) => {
		const value = input();
		value.valued_at = valuedAt;
		expect(() => calculateRedemptionValuation(value)).toThrow();
	}
);

it('sorts opaque deduction IDs by UTF-8 bytes without locale or UTF-16 ordering', () => {
	const value = gross();
	const low = String.fromCodePoint(0xe000);
	const high = String.fromCodePoint(0x1f600);
	value.event.receipt!.money_legs[0].id = high;
	value.event.receipt!.money_legs[1].id = low;
	value.event.receipt!.out_of_pocket.leg_ids = value.selection.deducted_leg_ids = [high, low];
	expect(calculateRedemptionValuation(value).deducted_leg_ids).toEqual([low, high]);
});
