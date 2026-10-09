import { pullNativeTable } from './native-finance';
import { assembleRewards, type Rewards } from '$lib/finance/rewards';
import type { Estate } from '$lib/finance/assemble';

export const LEGACY = ['id', 'program', 'points', 'scraped_at', 'deleted_at'];
const TABLES = {
	reward_programs: ['id', 'label', 'provider', 'account_id', 'deleted_at'],
	reward_components: [
		'id',
		'program_id',
		'component_key',
		'label',
		'unit',
		'role',
		'currency',
		'deleted_at'
	],
	reward_events: [
		'id',
		'component_id',
		'event_key',
		'kind',
		'state',
		'event_date',
		'occurred_at',
		'posted_date',
		'units_delta',
		'observed_at',
		'supersedes_id',
		'deleted_at'
	],
	points_balances: [
		...LEGACY,
		'component_id',
		'exact_amount',
		'basis',
		'source_as_of',
		'source_date',
		'period_start',
		'period_end_exclusive',
		'supersedes_id'
	],
	reward_terms: [
		'id',
		'program_id',
		'component_id',
		'term_key',
		'kind',
		'applicability',
		'effective_from',
		'effective_until',
		'source_as_of',
		'payload',
		'supersedes_id',
		'deleted_at'
	],
	redemption_valuations: [
		'id',
		'event_id',
		'basis',
		'comparable_amount',
		'currency',
		'comparable_scope',
		'reward_value',
		'rate_at_redemption',
		'units_consumed',
		'valued_at',
		'supersedes_id',
		'deleted_at'
	]
};
// Proved spend for an exact earning event: a ledger row cited as its evidence.
const LINKS = { to_kind: 'reward_events', from_kind: 'txn', rel: 'evidence_of' };

export interface RewardsView extends Rewards {
	typedUnavailable: boolean;
	valuesUnavailable: boolean;
	today: string;
}
export type RewardValue = { program_id: string; value_per_unit: string; revision: number };

export async function readRewardValues(
	db: D1Database | undefined
): Promise<{ values: RewardValue[]; unavailable: boolean }> {
	if (!db) return { values: [], unavailable: true };
	try {
		const { results } = await db
			.prepare('SELECT program_id, value_per_unit, revision FROM reward_values ORDER BY program_id')
			.all<RewardValue>();
		return { values: results, unavailable: false };
	} catch {
		return { values: [], unavailable: true };
	}
}

const money = (n: number) => (n.toFixed(2).replace(/\.?0+$/, '') || '0').replace(/^-0$/, '0');

/** Typed rewards with terms, valuations, owner values and linked spend. Throws when typed tables fail. */
export async function loadRewards(input: {
	hub: string;
	token: string;
	fetch: typeof fetch;
	db: D1Database | undefined;
	today: string;
	/** Loaded only when spend links exist; their ledger rows give the proved spend. */
	estate: () => Promise<Pick<Estate, 'accounts' | 'txns'>>;
}): Promise<RewardsView> {
	const pulls = Object.entries(TABLES).map(([table, columns]) =>
		pullNativeTable(input.hub, input.token, table, columns, input.fetch)
	);
	const [tables, edges, owner] = await Promise.all([
		Promise.all(pulls),
		pullNativeTable(
			input.hub,
			input.token,
			'provenance',
			['id', 'from_ref', 'to_ref', 'deleted_at'],
			input.fetch,
			LINKS
		),
		readRewardValues(input.db)
	]);
	const [programs, components, events, balances, terms, valuations] = tables;
	const live = edges.rows.filter((e) => e.deleted_at == null);
	const links: { event_id: string; amount: string; currency: string }[] = [];
	if (live.length) {
		const estate = await input.estate();
		const currency = new Map(estate.accounts.map((a) => [a.id, a.currency]));
		const ledger = new Map(estate.txns.map((t) => [`${t.source}:${t.source_id}`, t]));
		const byEvent = new Map<string, unknown[]>();
		for (const e of live)
			byEvent.set(String(e.to_ref), [...(byEvent.get(String(e.to_ref)) ?? []), e.from_ref]);
		for (const [event_id, refs] of byEvent) {
			const rows = refs.map((ref) => ledger.get(String(ref)));
			// One unresolved citation would understate spend and overstate the rate: drop the event.
			if (rows.some((t) => !t || !t.account_id || !currency.get(t.account_id))) continue;
			for (const t of rows)
				links.push({
					event_id,
					amount: money(-t!.amount),
					currency: currency.get(t!.account_id!)!
				});
		}
	}
	return {
		...assembleRewards(programs.rows, components.rows, events.rows, balances.rows, {
			complete: [...tables, edges].every((r) => r.complete),
			today: input.today,
			terms: terms.rows,
			valuations: valuations.rows,
			values: owner.values,
			links
		}),
		typedUnavailable: false,
		valuesUnavailable: owner.unavailable,
		today: input.today
	};
}
