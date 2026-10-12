import { readEstate, type EstateSource, type HubRow } from './estate';
import { assembleRewards, type RewardOptions, type Rewards } from '$lib/finance/rewards';
import type { Estate } from '$lib/finance/assemble';

export const LEGACY = ['id', 'program', 'points', 'scraped_at', 'deleted_at'];
const TABLES = [
	'reward_programs',
	'reward_components',
	'reward_events',
	'points_balances',
	'reward_terms',
	'redemption_valuations'
];

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

const current = (r: HubRow) => r.deleted_at == null;
const textOrNull = (v: unknown) => (typeof v === 'string' ? v : null);
/** Posted rows of the cards that carry reward programs, with the overlay facts eligibility needs. */
async function readCardLedgers(
	source: EstateSource,
	cards: Set<string>
): Promise<Pick<RewardOptions, 'ledgers' | 'ledgerUnavailable'>> {
	const owned = (r: Record<string, HubRow[]>) =>
		(r.accounts ?? []).filter((a) => current(a) && cards.has(String(a.id)));
	const ledgers = (r: Record<string, HubRow[]>) => {
		const sources = [...new Set(owned(r).map((a) => a.source))];
		if (sources.some((s) => typeof s !== 'string' || !/^[a-z][a-z0-9_]*$/.test(s)))
			throw new Error('Invalid source');
		return sources.map((s) => `txns_${s}`);
	};
	// Like /api/finance, a paged ledger read is used as is: rows are keyed by id, so pages never double count.
	const { rows } = await readEstate(source, ['accounts', 'overlay'], { expand: ledgers });
	const overlay = new Map(
		rows.overlay.filter(current).map((o) => [`${o.source}:${o.source_id}`, o] as const)
	);
	const result: NonNullable<RewardOptions['ledgers']> = {};
	for (const a of owned(rows)) {
		const id = String(a.id);
		result[id] = {
			currency: String(a.currency),
			rows: (rows[`txns_${a.source}`] ?? [])
				.filter((t) => current(t) && t.account_id === id && t.status !== 'Pending')
				.map((t) => {
					const o = overlay.get(`${a.source}:${t.id}`);
					return {
						account_id: id,
						date: String(t.date),
						posted_date: textOrNull(t.posted_date),
						amount: t.amount as number,
						name: textOrNull(t.name),
						bank_category: textOrNull(t.bank_category),
						category: textOrNull(o?.category),
						internal: o?.internal === 1 || o?.internal === true
					};
				})
		};
	}
	return { ledgers: result };
}

const money = (n: number) => (n.toFixed(2).replace(/\.?0+$/, '') || '0').replace(/^-0$/, '0');

/** Typed rewards with terms, valuations, owner values and linked spend. Throws when typed tables fail. */
export async function loadRewards(input: {
	source: EstateSource;
	db: D1Database | undefined;
	today: string;
	/** Loaded only when spend links exist; their ledger rows give the proved spend. */
	estate: () => Promise<Pick<Estate, 'accounts' | 'txns'>>;
}): Promise<RewardsView> {
	const [{ rows, complete }, owner] = await Promise.all([
		readEstate(input.source, TABLES, { slices: ['reward_links'] }),
		readRewardValues(input.db)
	]);
	// Links matter only for earn events and valuations only for redeem events.
	const kinds = new Set(rows.reward_events.filter((e) => e.deleted_at == null).map((e) => e.kind));
	const edges = kinds.has('earn') ? rows.reward_links : [];
	const valuations = kinds.has('redeem') ? rows.redemption_valuations : [];
	const live = edges.filter((e) => e.deleted_at == null);
	const links: { event_id: string; amount: string; currency: string }[] = [];
	if (live.length) {
		const estate = await input.estate();
		const currency = new Map(estate.accounts.map((a) => [a.id, a.currency]));
		const ledger = new Map(estate.txns.map((t) => [`${t.source}:${t.source_id}`, t]));
		const byEvent = new Map<string, unknown[]>();
		for (const e of live)
			byEvent.set(String(e.to_ref), [...(byEvent.get(String(e.to_ref)) ?? []), e.from_ref]);
		for (const [event_id, refs] of byEvent) {
			const cited = refs.map((ref) => ledger.get(String(ref)));
			// One unresolved citation would understate spend and overstate the rate: drop the event.
			if (cited.some((t) => !t || !t.account_id || !currency.get(t.account_id))) continue;
			for (const t of cited)
				links.push({
					event_id,
					amount: money(-t!.amount),
					currency: currency.get(t!.account_id!)!
				});
		}
	}
	// Statement-period earnings are rated against their cards' posted purchases.
	const cards = new Set(
		rows.reward_programs
			.filter(current)
			.flatMap((p) => (typeof p.account_id === 'string' ? [p.account_id] : []))
	);
	let card: Pick<RewardOptions, 'ledgers' | 'ledgerUnavailable'> = {};
	if (cards.size && rows.reward_events.some((e) => current(e) && e.period_start != null))
		try {
			card = await readCardLedgers(input.source, cards);
		} catch {
			card = { ledgerUnavailable: 'Card purchases could not be read. Try refreshing.' };
		}
	return {
		...assembleRewards(
			rows.reward_programs,
			rows.reward_components,
			rows.reward_events,
			rows.points_balances,
			{
				complete,
				today: input.today,
				terms: rows.reward_terms,
				valuations,
				values: owner.values,
				links,
				...card
			}
		),
		typedUnavailable: false,
		valuesUnavailable: owner.unavailable,
		today: input.today
	};
}
