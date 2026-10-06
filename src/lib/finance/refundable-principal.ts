import { isDate } from './presets';

export interface PrincipalAsset {
	id: string;
	currency: string;
}
export interface OwnedAllocation {
	id: string;
	currency: string;
	amountMinor: number;
}
export interface PrincipalEvent {
	id: string;
	assetId: string;
	currency: string;
	date: string;
	kind: 'fund' | 'refund' | 'forfeit';
	amountMinor: number;
	allocationId: string | null;
	evidenceRef: string;
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const currency = (value: string) => /^[A-Z]{3}$/.test(value);
function unique<T extends { id: string }>(rows: T[]): Map<string, T> {
	const result = new Map<string, T>();
	for (const row of rows) {
		if (!nonempty(row.id) || result.has(row.id)) throw new Error('Invalid or duplicate identity.');
		result.set(row.id, row);
	}
	return result;
}
function minor(value: bigint): number {
	const result = Number(value);
	if (!Number.isSafeInteger(result)) throw new Error('Minor-unit total exceeds safe precision.');
	return result;
}

/**
 * Read-only calculation over complete, current principal history and owned allocations.
 * Balances are as-of; activity classifies every supplied allocation, leaving date filters
 * to the caller. Allocation IDs must distinguish raw source/row from share IDs. This is
 * not a persistence validator: writers must atomically guard full allocation membership.
 */
export function refundablePrincipal(
	assets: PrincipalAsset[],
	events: PrincipalEvent[],
	allocations: OwnedAllocation[],
	asOf: string
): { balances: Record<string, number>; activity: Record<string, number> } {
	if (!isDate(asOf)) throw new Error('Invalid as-of date.');
	const assetById = unique(assets),
		allocationById = unique(allocations);
	unique(events);
	for (const asset of assets)
		if (!currency(asset.currency)) throw new Error('Invalid asset currency.');
	for (const allocation of allocations) {
		if (!currency(allocation.currency) || !Number.isSafeInteger(allocation.amountMinor))
			throw new Error('Invalid allocation currency or minor units.');
	}
	const linked = new Map<string, bigint>();
	const changes = new Map<string, Map<string, bigint>>();
	for (const event of events) {
		const asset = assetById.get(event.assetId);
		if (!asset || event.currency !== asset.currency)
			throw new Error('Unknown asset or currency mismatch.');
		if (
			!isDate(event.date) ||
			!nonempty(event.evidenceRef) ||
			!Number.isSafeInteger(event.amountMinor) ||
			event.amountMinor <= 0
		)
			throw new Error('Invalid event date, evidence or positive minor units.');
		if (!['fund', 'refund', 'forfeit'].includes(event.kind))
			throw new Error('Invalid principal event kind.');
		const amount = BigInt(event.amountMinor);
		if (event.kind === 'forfeit') {
			if (event.allocationId !== null)
				throw new Error('Forfeit must not invent a cash allocation.');
		} else {
			const allocation =
				event.allocationId === null ? undefined : allocationById.get(event.allocationId);
			if (!allocation) throw new Error('Missing owned allocation.');
			if (allocation.currency !== event.currency) throw new Error('Allocation currency mismatch.');
			if (Math.sign(allocation.amountMinor) !== (event.kind === 'fund' ? -1 : 1))
				throw new Error('Allocation sign mismatch.');
			const total = (linked.get(allocation.id) ?? 0n) + amount;
			if (total > BigInt(Math.abs(allocation.amountMinor)))
				throw new Error('Principal exceeds owned allocation.');
			linked.set(allocation.id, total);
		}
		const dated = changes.get(asset.id) ?? new Map<string, bigint>();
		dated.set(
			event.date,
			(dated.get(event.date) ?? 0n) + (event.kind === 'fund' ? amount : -amount)
		);
		changes.set(asset.id, dated);
	}
	const balances = Object.fromEntries(
		assets.map((asset) => {
			let running = 0n,
				closing = 0n;
			for (const [date, change] of [...(changes.get(asset.id) ?? [])].sort(([a], [b]) =>
				a.localeCompare(b)
			)) {
				running += change;
				if (running < 0n) throw new Error('Returned or forfeited principal exceeds funding.');
				minor(running);
				if (date <= asOf) closing = running;
			}
			return [asset.id, minor(closing)];
		})
	);
	const activity = Object.fromEntries(
		allocations.map((allocation) => [
			allocation.id,
			minor(
				BigInt(allocation.amountMinor) -
					BigInt(Math.sign(allocation.amountMinor)) * (linked.get(allocation.id) ?? 0n)
			)
		])
	);
	return { balances, activity };
}
