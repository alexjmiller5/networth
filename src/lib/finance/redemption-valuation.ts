/** Pure proposal calculation. Evidence resolution, approval and guarded publication belong to callers. */
type Scope = 'gross_benefit' | 'reward_funded_portion';
type Basis = 'user_override' | 'provider_comparable' | 'estimate';
type Role = 'redeemable' | 'qualifying' | 'cash_reward' | 'certificate';
interface MoneyLeg {
	id: string;
	role: string;
	amount: string;
	currency: string;
	included_in: string | null;
}
interface Receipt {
	money_legs: MoneyLeg[];
	out_of_pocket: {
		coverage: 'complete' | 'partial' | 'unknown';
		authority: 'provider' | 'user' | 'unknown';
		leg_ids: string[];
		method_key: string | null;
	};
}
interface EstimateTerm {
	id: string;
	program_id: string;
	component_id: string | null;
	kind: string;
	authority: string;
	applicability: string;
	effective_from: string | null;
	effective_until: string | null;
	payload: {
		schema_version: number;
		component_id: string;
		method_key: string | null;
		currency: string;
		value_per_unit: string;
		convention: string;
		conditions: string[];
	};
}
export interface RedemptionValuationInput {
	event: {
		id: string;
		component_id: string;
		kind: string;
		state: string;
		event_date: string | null;
		units_delta: string | null;
		receipt: Receipt | null;
	};
	component: { id: string; program_id: string; unit: string; role: Role; currency: string | null };
	selection: {
		basis: Basis;
		comparable_amount: string;
		currency: string;
		comparable_scope: Scope;
		units_consumed: string;
		deducted_leg_ids: string[];
		estimate_term_id: string | null;
	};
	/** Already resolved evidence, scoped to this exact event and selected amount/scope. */
	evidence: {
		comparable_amount: string;
		estimate_term_id: string | null;
		event_id: string;
		component_id: string;
		unit: string;
		role: Role;
		currency: string;
		comparable_scope: Scope;
		method_key: string | null;
		authority: string;
		applicability: string;
		reference: string;
		source_amount_scope_rule: string | null;
		cost_coverage_reference: string | null;
	};
	/** A verified read-set assertion, not a chain resolver or permission to publish. */
	context: { event_head_id: string; chain_verified: boolean; method_key: string | null };
	estimate_term: EstimateTerm | null;
	valued_at: string;
}

export interface Decimal {
	coefficient: bigint;
	scale: number;
}
function fail(reason: string): never {
	throw new Error(`Invalid redemption valuation: ${reason}`);
}
function requireValue(condition: unknown, reason: string): asserts condition {
	if (!condition) fail(reason);
}
function identity(value: unknown): asserts value is string {
	requireValue(
		typeof value === 'string' && value.trim().length > 0,
		'missing identity or evidence'
	);
}
function currency(value: unknown): asserts value is string {
	requireValue(
		typeof value === 'string' && Intl.supportedValuesOf('currency').includes(value),
		'currency'
	);
}
function date(value: unknown): asserts value is string {
	requireValue(
		typeof value === 'string' &&
			/^\d{4}-\d{2}-\d{2}$/.test(value) &&
			Number.isFinite(Date.parse(value)) &&
			new Date(value).toISOString().slice(0, 10) === value,
		'date'
	);
}
export function decimal(value: unknown): Decimal {
	requireValue(
		typeof value === 'string' &&
			value.length <= 102 &&
			/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/.test(value) &&
			value !== '-0',
		'canonical decimal'
	);
	const [integer, fraction = ''] = value.split('.');
	requireValue(
		integer.replace('-', '').length + fraction.length <= 100 && fraction.length <= 50,
		'decimal bounds'
	);
	return { coefficient: BigInt(integer + fraction), scale: fraction.length };
}
const power = (scale: number) => 10n ** BigInt(scale);
export function canonical(value: Decimal): string {
	const negative = value.coefficient < 0n;
	let digits = (negative ? -value.coefficient : value.coefficient)
		.toString()
		.padStart(value.scale + 1, '0');
	if (value.scale)
		digits = `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/\.?0+$/, '');
	const result = negative && value.coefficient !== 0n ? '-' + digits : digits;
	decimal(result); // Never round an exact result to fit the input/output contract.
	return result;
}
export function subtract(a: Decimal, b: Decimal): Decimal {
	const scale = Math.max(a.scale, b.scale);
	return {
		coefficient: a.coefficient * power(scale - a.scale) - b.coefficient * power(scale - b.scale),
		scale
	};
}
export function multiply(a: Decimal, b: Decimal): Decimal {
	return { coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale };
}
/** Nonnegative value / positive units at a fixed scale, rounded half-even. */
export function quotient(value: Decimal, units: Decimal, scale: number): string {
	requireValue(value.coefficient >= 0n && units.coefficient > 0n, 'quotient operands');
	const numerator = value.coefficient * power(units.scale + scale);
	const denominator = units.coefficient * power(value.scale);
	let result = numerator / denominator;
	const twiceRemainder = (numerator % denominator) * 2n;
	if (twiceRemainder > denominator || (twiceRemainder === denominator && result % 2n === 1n))
		result++;
	return canonical({ coefficient: result, scale });
}
const displayRate = (value: Decimal, units: Decimal) => quotient(value, units, 18);
function idSet(values: string[]): string[] {
	requireValue(Array.isArray(values), 'leg set');
	values.forEach(identity);
	requireValue(new Set(values).size === values.length, 'duplicate leg');
	const encoded = new Map(values.map((value) => [value, new TextEncoder().encode(value)]));
	return [...values].sort((a, b) => {
		const left = encoded.get(a)!;
		const right = encoded.get(b)!;
		for (let i = 0; i < Math.min(left.length, right.length); i++)
			if (left[i] !== right[i]) return left[i] - right[i];
		return left.length - right.length;
	});
}
function deductCosts(
	input: RedemptionValuationInput,
	amount: Decimal,
	selected: string[]
): Decimal {
	const { receipt } = input.event;
	requireValue(receipt && Array.isArray(receipt.money_legs), 'gross receipt required');
	const costs = receipt.out_of_pocket;
	requireValue(
		costs?.coverage === 'complete' && ['provider', 'user'].includes(costs.authority),
		'complete attributed costs required'
	);
	identity(input.evidence.cost_coverage_reference);
	requireValue(costs.method_key === input.context.method_key, 'cost method');
	const canonicalIds = idSet(costs.leg_ids);
	requireValue(
		JSON.stringify(canonicalIds) === JSON.stringify(selected),
		'whole cost set required'
	);
	const legs = new Map<string, MoneyLeg>();
	for (const leg of receipt.money_legs) {
		identity(leg.id);
		requireValue(!legs.has(leg.id), 'duplicate receipt leg');
		requireValue(
			[
				'purchase_gross',
				'subtotal',
				'tax',
				'fee',
				'tip',
				'cash_paid',
				'statement_credit',
				'face_value'
			].includes(leg.role),
			'receipt role'
		);
		decimal(leg.amount);
		currency(leg.currency);
		requireValue(leg.currency === input.selection.currency, 'mixed receipt currencies');
		legs.set(leg.id, leg);
	}
	const selectedSet = new Set(selected);
	for (const leg of legs.values()) {
		const ancestors = new Set([leg.id]);
		let ancestor = leg.included_in;
		while (ancestor !== null) {
			identity(ancestor);
			requireValue(
				legs.has(ancestor) && !ancestors.has(ancestor),
				'missing or cyclic receipt ancestry'
			);
			requireValue(!(selectedSet.has(leg.id) && selectedSet.has(ancestor)), 'overlapping costs');
			ancestors.add(ancestor);
			ancestor = legs.get(ancestor)!.included_in;
		}
		if (leg.role === 'cash_paid' && decimal(leg.amount).coefficient > 0n)
			requireValue(
				[...ancestors].some((id) => selectedSet.has(id)),
				'unrepresented cash paid'
			);
	}
	let value = amount;
	for (const id of selected) {
		const leg = legs.get(id);
		requireValue(
			leg && ['cash_paid', 'tax', 'fee', 'tip'].includes(leg.role),
			'foreign or noncost leg'
		);
		const cost = decimal(leg.amount);
		requireValue(cost.coefficient > 0n, 'deduction must be a positive cost');
		value = subtract(value, cost);
	}
	return value;
}

/** Returns a frozen calculation proposal, never a published or automatically selected valuation. */
export function calculateRedemptionValuation(input: RedemptionValuationInput) {
	const { event, component, selection, evidence, context, estimate_term: term } = input;
	[
		event.id,
		event.component_id,
		component.id,
		component.program_id,
		component.unit,
		evidence.reference
	].forEach(identity);
	requireValue(
		context.chain_verified === true && context.event_head_id === event.id,
		'verified event head required'
	);
	requireValue(event.kind === 'redeem' && event.state === 'posted', 'posted redemption required');
	requireValue(
		component.id === event.component_id &&
			['redeemable', 'cash_reward', 'certificate'].includes(component.role),
		'component identity or role'
	);
	currency(selection.currency);
	requireValue(
		component.currency !== null || !Intl.supportedValuesOf('currency').includes(component.unit),
		'missing native currency'
	);
	if (component.currency !== null) {
		currency(component.currency);
		requireValue(
			component.currency === selection.currency && component.unit === component.currency,
			'native currency mismatch'
		);
	}
	requireValue(
		component.role !== 'cash_reward' || component.currency !== null,
		'cash component currency'
	);
	requireValue(
		['gross_benefit', 'reward_funded_portion'].includes(selection.comparable_scope),
		'comparable scope'
	);
	requireValue(
		evidence.comparable_amount === selection.comparable_amount &&
			evidence.estimate_term_id === selection.estimate_term_id &&
			evidence.event_id === event.id &&
			evidence.component_id === component.id &&
			evidence.unit === component.unit &&
			evidence.role === component.role &&
			evidence.currency === selection.currency &&
			evidence.comparable_scope === selection.comparable_scope &&
			evidence.method_key === context.method_key,
		'evidence scope mismatch'
	);
	if (context.method_key !== null) identity(context.method_key);
	const delta = decimal(event.units_delta);
	const units = decimal(selection.units_consumed);
	requireValue(
		delta.coefficient < 0n &&
			units.coefficient > 0n &&
			canonical({ ...delta, coefficient: -delta.coefficient }) === selection.units_consumed,
		'consumed native units'
	);
	const amount = decimal(selection.comparable_amount);
	requireValue(amount.coefficient >= 0n, 'negative comparable value');
	if (selection.basis === 'user_override' || selection.basis === 'estimate')
		requireValue(
			evidence.authority === 'user' && evidence.applicability === 'owner_confirmed',
			'owner evidence required'
		);
	else {
		requireValue(
			selection.basis === 'provider_comparable' &&
				evidence.authority === 'provider' &&
				['account_observed', 'owner_confirmed'].includes(evidence.applicability),
			'provider evidence required'
		);
		identity(evidence.source_amount_scope_rule);
	}
	if (selection.basis === 'estimate') {
		requireValue(
			term &&
				term.id === selection.estimate_term_id &&
				term.kind === 'valuation_estimate' &&
				term.authority === 'user' &&
				term.applicability === 'owner_confirmed',
			'approved estimate version required'
		);
		identity(term.id);
		requireValue(
			term.program_id === component.program_id &&
				(term.component_id === null || term.component_id === component.id) &&
				term.payload.schema_version === 1 &&
				term.payload.component_id === component.id &&
				term.payload.currency === selection.currency &&
				term.payload.method_key === context.method_key,
			'estimate scope'
		);
		identity(term.payload.convention);
		requireValue(
			Array.isArray(term.payload.conditions) && term.payload.conditions.length === 0,
			'unresolved estimate conditions'
		);
		date(event.event_date);
		date(term.effective_from);
		if (term.effective_until !== null) {
			date(term.effective_until);
			requireValue(
				term.effective_until > term.effective_from && event.event_date < term.effective_until,
				'expired estimate'
			);
		}
		requireValue(event.event_date >= term.effective_from, 'future estimate');
		requireValue(
			selection.comparable_scope === 'reward_funded_portion',
			'estimate is reward funded'
		);
		const rate = decimal(term.payload.value_per_unit);
		requireValue(rate.coefficient >= 0n, 'negative estimate');
		const expected = canonical({
			coefficient: rate.coefficient * units.coefficient,
			scale: rate.scale + units.scale
		});
		requireValue(expected === selection.comparable_amount, 'estimate amount mismatch');
	} else requireValue(selection.estimate_term_id === null, 'unexpected estimate reference');
	const selected = idSet(selection.deducted_leg_ids);
	if (selection.comparable_scope === 'reward_funded_portion')
		requireValue(selected.length === 0, 'reward-funded deductions');
	const value =
		selection.comparable_scope === 'gross_benefit' ? deductCosts(input, amount, selected) : amount;
	requireValue(value.coefficient >= 0n, 'negative reward value');
	requireValue(
		typeof input.valued_at === 'string' &&
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.valued_at) &&
			Number.isFinite(Date.parse(input.valued_at)) &&
			new Date(input.valued_at).toISOString() === input.valued_at,
		'valuation timestamp'
	);
	return Object.freeze({
		event_id: event.id,
		basis: selection.basis,
		estimate_term_id: selection.estimate_term_id,
		comparable_amount: selection.comparable_amount,
		currency: selection.currency,
		comparable_scope: selection.comparable_scope,
		deducted_leg_ids: Object.freeze(selected),
		units_consumed: selection.units_consumed,
		reward_value: canonical(value),
		rate_at_redemption: displayRate(value, units),
		rate_scale: 18 as const,
		rate_rounding: 'half_even' as const,
		calculation_version: 'redemption-valuation-v1' as const,
		valued_at: input.valued_at
	});
}
