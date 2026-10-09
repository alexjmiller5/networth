import { assetClass } from './series';
import { refundablePrincipal, type PrincipalEvent } from './refundable-principal';
import type { AccountValuation } from './valuation';
// Join raw finance facts with their judgment layer. Spending uses dated
// shares; monetary balances use ledger effects verified against source gates.
import type {
	Account,
	AccountCoverage,
	AccountType,
	Category,
	CategoryKind,
	PointsBalance,
	Txn,
	TxnShare
} from './types';

export interface HubRow {
	[col: string]: unknown;
}

export interface EstateTables {
	accounts: HubRow[];
	overlay: HubRow[];
	shares: HubRow[];
	categories: HubRow[];
	scrape_runs: HubRow[];
	venmo_statement_lines: HubRow[];
	points: HubRow[];
	txns: Record<string, HubRow[]>;
	/** Noncash refundable assets, their dated principal events and evidence_of edges. */
	assets?: HubRow[];
	asset_events?: HubRow[];
	asset_evidence?: HubRow[];
	/** Redemptions whose valuation carries a spending category count as points-paid spending. */
	reward_components?: HubRow[];
	reward_events?: HubRow[];
	redemption_valuations?: HubRow[];
}

export interface Estate {
	accounts: Account[];
	txns: Txn[];
	categories: Category[];
	points: PointsBalance[];
	coverage: AccountCoverage[];
	/** Balance-only noncash assets; their ledger rows are internal txns. Not reconciled accounts. */
	assets: Account[];
	/** Daily market value of investment accounts, when the price cache is configured. */
	valuations?: AccountValuation[];
}

const live = (r: HubRow): boolean => r.deleted_at == null;
const str = (v: unknown): string => (v == null ? '' : String(v));

function id(v: unknown): string {
	if (typeof v !== 'string' || !v.trim()) throw new Error('Missing finance identity');
	return v;
}

function num(v: unknown): number {
	if (
		typeof v !== 'number' &&
		!(typeof v === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v.trim()))
	) {
		throw new Error('Invalid finance numeric value');
	}
	const n = Number(v);
	if (!Number.isFinite(n)) throw new Error('Invalid finance numeric value');
	return n;
}

function flag(v: unknown): boolean {
	if (v == null || v === false || v === 0 || v === '0') return false;
	if (v === true || v === 1 || v === '1') return true;
	throw new Error('Invalid finance flag');
}

function date(v: unknown): string {
	if (
		typeof v !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}$/.test(v) ||
		!Number.isFinite(Date.parse(v)) ||
		new Date(v).toISOString().slice(0, 10) !== v
	) {
		throw new Error('Invalid finance date');
	}
	return v;
}

function timestamp(v: unknown): string {
	if (
		typeof v !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) ||
		!Number.isFinite(Date.parse(v))
	)
		throw new Error('Invalid finance timestamp');
	date(v.slice(0, 10));
	return new Date(v).toISOString();
}

function object(v: unknown): HubRow {
	if (typeof v === 'string') {
		try {
			v = JSON.parse(v);
		} catch {
			return {};
		}
	}
	return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as HubRow) : {};
}

export function assemble(t: EstateTables): Estate {
	const accounts: Account[] = t.accounts.filter(live).map((r) => {
		const history =
			typeof r.name_history === 'string' ? JSON.parse(r.name_history) : (r.name_history ?? []);
		if (!Array.isArray(history)) throw new Error('Invalid account name history');
		const nameHistory = history.map((entry: HubRow, i: number) => {
			const until = date(entry?.until);
			if (i > 0 && until <= history[i - 1].until) throw new Error('Invalid account name history');
			return { name: id(entry.name), until };
		});
		const logo = str(r.logo) || undefined;
		if (logo && (!logo.startsWith('data:image/svg+xml,') || logo.length > 100_000))
			throw new Error('Invalid account logo');
		if (
			![
				'checking',
				'savings',
				'credit_card',
				'p2p',
				'brokerage',
				'ira',
				'401k',
				'cash',
				'stored_value'
			].includes(str(r.type))
		) {
			throw new Error('Invalid finance account type');
		}
		return {
			id: id(r.id),
			bank: str(r.bank),
			name: str(r.name),
			type: str(r.type) as AccountType,
			source: id(r.source),
			currency: str(r.currency),
			closed: flag(r.is_closed) || r.closed != null,
			nameHistory,
			logo
		};
	});
	const accountOf = new Map(accounts.map((a) => [a.id, a]));
	if (accountOf.size !== accounts.length) throw new Error('Duplicate finance account');
	const categories: Category[] = t.categories
		.filter(live)
		.map((r) => {
			if (!['spending', 'income', 'transfer', 'unknown'].includes(str(r.kind))) {
				throw new Error('Invalid finance category kind');
			}
			return {
				id: str(r.id),
				name: str(r.name),
				kind: str(r.kind) as CategoryKind,
				icon: str(r.icon),
				sort: num(r.sort)
			};
		})
		.sort((a, b) => a.sort - b.sort);
	const categoryOf = new Map(categories.map((c) => [c.name, c]));
	const categoryKind = (name: string): CategoryKind => {
		const c = categoryOf.get(name);
		if (!c) throw new Error('Unknown finance category');
		return c.kind;
	};
	const overlay = new Map<string, HubRow>();
	for (const o of t.overlay.filter(live)) overlay.set(`${str(o.source)}:${str(o.source_id)}`, o);

	const shares = new Map<string, TxnShare[]>();
	const shareById = new Map<string, { parent: string; share: TxnShare }>();
	const standalone: Txn[] = [];
	for (const s of t.shares.filter(live)) {
		if ((s.source == null) !== (s.source_id == null))
			throw new Error('Incomplete finance share parent');
		const share: TxnShare = {
			date: date(s.date),
			amount: num(s.amount),
			category: str(s.category),
			categoryKind: categoryKind(str(s.category))
		};
		if (share.amount === 0) throw new Error('Zero finance share');
		if (s.source == null) {
			standalone.push({
				...share,
				date: share.date!,
				source: null,
				source_id: null,
				account_id: null,
				balanceAmount: null,
				standalone: true,
				synthetic: false,
				internal: false,
				excluded: false
			});
		} else {
			const key = `${str(s.source)}:${str(s.source_id)}`;
			const list = shares.get(key) ?? [];
			list.push(share);
			shares.set(key, list);
			if (s.id != null) shareById.set(id(s.id), { parent: key, share });
		}
	}

	const statements = new Map<string, HubRow[]>();
	for (const s of t.venmo_statement_lines.filter(live)) {
		if (s.txn_id == null) continue;
		const key = str(s.txn_id);
		const list = statements.get(key) ?? [];
		list.push(s);
		statements.set(key, list);
	}
	const txns: Txn[] = [];
	const txnByKey = new Map<string, Txn>();
	for (const [source, rows] of Object.entries(t.txns)) {
		for (const r of rows.filter(live)) {
			const a = accountOf.get(str(r.account_id));
			if (!a || a.source !== source) throw new Error('Invalid finance account reference');
			const key = `${source}:${id(r.id)}`;
			if (txnByKey.has(key)) throw new Error('Duplicate finance transaction');
			const o = overlay.get(key);
			const amount = num(r.amount);
			const synthetic = flag(r.synthetic);
			let balanceAmount: number | null = assetClass(a) === 'investments' ? null : amount;
			if (source === 'venmo' && !synthetic) {
				const lines = statements.get(str(r.id)) ?? [];
				// The stored link is authoritative: statement amounts can differ from
				// stories because of fees and refund signs. Verify the final ledger.
				if (lines.length !== 1) {
					balanceAmount = null;
				} else if (lines[0].type === 'Refunded transaction') {
					const destination = str(lines[0].destination).trim();
					// The stories feed omits a canceled payment and returns only its
					// positive refund. The CSV retains the original negative payment;
					// together that pair nets to zero, including balance-funded pairs.
					const canceledPayment = num(lines[0].amount) < 0 && amount > 0;
					balanceAmount = canceledPayment
						? 0
						: destination === 'Venmo balance'
							? amount
							: destination
								? 0
								: null;
				} else if (
					num(lines[0].amount) < 0 &&
					!['', 'Venmo balance'].includes(str(lines[0].funding_source))
				) {
					balanceAmount = 0;
				}
			}
			const txn: Txn = {
				source,
				source_id: str(r.id),
				account_id: a.id,
				date: date(r.date),
				amount,
				balanceAmount,
				synthetic,
				internal: flag(o?.internal),
				excluded: flag(o?.excluded),
				standalone: false
			};
			if (o?.category != null) {
				txn.category = str(o.category);
				txn.categoryKind = categoryKind(txn.category);
			}
			if (r.status != null) txn.status = str(r.status);
			if (r.qty != null) txn.qty = num(r.qty);
			if (r.ticker != null) txn.ticker = str(r.ticker);
			const sh = shares.get(key);
			if (sh) {
				if (o?.category != null) throw new Error('Finance share and parent both have a category');
				if (
					sh.some(
						(s) =>
							Math.sign(s.amount) !== Math.sign(amount) ||
							Math.abs(s.amount) > Math.abs(amount) + 0.005
					) ||
					Math.abs(sh.reduce((sum, s) => sum + s.amount, 0)) > Math.abs(amount) + 0.01
				) {
					throw new Error('Finance shares exceed or disagree with their parent');
				}
				txn.shares = sh;
				shares.delete(key);
			}
			txns.push(txn);
			txnByKey.set(key, txn);
		}
	}
	if (shares.size) throw new Error('Finance share parent is missing');
	const noncash = noncashAssets(t, txnByKey, shareById, accountOf);
	txns.push(...standalone, ...pointsPaid(t, categoryKind), ...noncash.ledger);
	txns.sort((a, b) => a.date.localeCompare(b.date));

	const latestRun = new Map<string, HubRow>();
	for (const r of t.scrape_runs.filter(live)) {
		const gates = object(r.stated_balances);
		const unitGates = object(gates.units);
		for (const account of accounts) {
			if (
				account.source !== r.source ||
				(!Object.hasOwn(gates, account.id) && !Object.hasOwn(unitGates, account.id))
			)
				continue;
			const prev = latestRun.get(account.id);
			const finished = Date.parse(str(r.finished_at));
			// An explicit malformed/failed checkpoint cannot silently revive older proof.
			if (!prev || !Number.isFinite(finished) || finished > Date.parse(str(prev.finished_at)))
				latestRun.set(account.id, r);
		}
	}
	const coverage: AccountCoverage[] = accounts.map((a) => {
		const rows = txns.filter((r) => r.account_id === a.id);
		const r = latestRun.get(a.id);
		const gates = object(r?.stated_balances);
		const money = gates[a.id];
		const hasMoney = typeof money === 'number' && Number.isFinite(money);
		const units = object(object(gates.units)[a.id]);
		const hasUnits = Object.keys(units).length > 0;
		const c: AccountCoverage = {
			account_id: a.id,
			status: 'unverified',
			basis: hasMoney ? 'money' : hasUnits ? 'units' : 'none',
			asOf: r && Number.isFinite(Date.parse(str(r.finished_at))) ? str(r.finished_at) : null,
			firstTransaction: rows[0]?.date ?? null,
			lastTransaction: rows.at(-1)?.date ?? null,
			transactionCount: rows.length,
			reasons: []
		};
		if (!rows.length) {
			c.status = 'missing';
			c.reasons.push('No transaction history');
		} else if (assetClass(a) === 'investments') {
			c.status = 'investment-unvalued';
			c.reasons.push(
				'Investment market prices unavailable; cash or contributions are not market value'
			);
			if (hasUnits) {
				const tickers = new Set([
					...Object.keys(units),
					...rows.flatMap((t) => (t.ticker ? [t.ticker] : []))
				]);
				for (const ticker of tickers) {
					const stated = Object.hasOwn(units, ticker) ? units[ticker] : 0;
					const qty = rows
						.filter((t) => t.ticker === ticker)
						.reduce((sum, t) => sum + (t.qty ?? 0), 0);
					if (
						typeof stated !== 'number' ||
						!Number.isFinite(stated) ||
						Math.abs(qty - stated) > 0.0015
					) {
						c.reasons.push('Investment quantities do not match the unit gate');
						break;
					}
				}
			}
			// Custody cash is the ledger's own cross-check, never an extra asset.
			const cash = rows
				.filter((t) => !c.asOf || t.date <= c.asOf.slice(0, 10))
				.reduce((sum, t) => sum + t.amount, 0);
			if (hasMoney && Math.abs(Math.round(cash * 100) - Math.round(money * 100)) > 1)
				c.reasons.push('Custody cash does not match the monetary gate');
			const rawUnits = object(gates.units)[a.id];
			const explicitPositions =
				rawUnits !== null && typeof rawUnits === 'object' && !Array.isArray(rawUnits);
			const tickers = new Set([
				...Object.keys(units),
				...rows.flatMap((t) => (t.ticker ? [t.ticker] : []))
			]);
			const flat =
				rows.every((t) => t.qty == null || t.qty === 0 || Boolean(t.ticker?.trim())) &&
				[...tickers].every((ticker) => {
					const stated = Object.hasOwn(units, ticker) ? units[ticker] : 0;
					const history = rows.filter((t) => t.ticker === ticker);
					return (
						stated === 0 &&
						history.every((t) => t.qty != null) &&
						Math.abs(history.reduce((sum, t) => sum + (t.qty ?? 0), 0)) <= 0.0015
					);
				});
			if (
				a.closed &&
				a.currency === 'USD' &&
				r?.status === 'ok' &&
				flag(r.reconciled) &&
				c.asOf &&
				c.lastTransaction! <= c.asOf.slice(0, 10) &&
				hasMoney &&
				money === 0 &&
				Math.round(rows.reduce((sum, t) => sum + t.amount, 0) * 100) === 0 &&
				explicitPositions &&
				flat
			) {
				c.status = 'verified-closed-zero';
				c.currentBalance = 0;
				c.reasons = [
					'Current cash and positions verify zero; historical market values remain unavailable'
				];
			}
		} else {
			if (a.currency !== 'USD') c.reasons.push('Unsupported or missing account currency');
			if (!r || r.status !== 'ok' || !flag(r.reconciled) || !c.asOf)
				c.reasons.push('No successful reconciliation run');
			if (!hasMoney) c.reasons.push('No monetary gate for this account');
			if (rows.some((t) => t.balanceAmount == null))
				c.reasons.push('Missing or ambiguous balance evidence');
			const derived = rows.reduce((sum, t) => sum + (t.balanceAmount ?? 0), 0);
			if (hasMoney && Math.abs(Math.round(derived * 100) - Math.round(money * 100)) > 1) {
				c.reasons.push('Derived ledger does not match the monetary gate');
			}
			if (c.asOf && c.lastTransaction! > c.asOf.slice(0, 10))
				c.reasons.push('Transactions extend beyond the reconciliation date');
			if (!c.reasons.length) c.status = 'verified';
		}
		return c;
	});

	const points: PointsBalance[] = t.points.filter(live).map((p) => ({
		program: str(p.program),
		points: num(p.points),
		estValue: p.est_value == null ? null : num(p.est_value),
		scrapedAt: timestamp(p.scraped_at)
	}));
	return { accounts, txns, categories, points, coverage, assets: noncash.assets };
}

/** Categorized redemption valuations become spending funded by native units: a dated,
 * account-less row worth the frozen reward value. Only chain heads count; balances never see them. */
function pointsPaid(t: EstateTables, categoryKind: (name: string) => CategoryKind): Txn[] {
	const valuations = (t.redemption_valuations ?? []).filter(live);
	const events = new Map((t.reward_events ?? []).filter(live).map((e) => [id(e.id), e]));
	const unitOf = new Map(
		(t.reward_components ?? []).filter(live).map((c) => [id(c.id), str(c.unit)])
	);
	const replaced = new Set(
		[...valuations, ...events.values()].flatMap((r) =>
			r.supersedes_id == null ? [] : [str(r.supersedes_id)]
		)
	);
	return valuations.flatMap((v): Txn[] => {
		if (v.category == null || replaced.has(id(v.id))) return [];
		const e = events.get(str(v.event_id));
		if (e?.kind !== 'redeem' || e.state !== 'posted')
			throw new Error('Points-paid redemption is missing its posted event');
		const amount = -num(v.reward_value);
		// ponytail: dollars only, like every other flow here; other currencies stay unavailable.
		if (replaced.has(id(e.id)) || v.currency !== 'USD' || !amount) return [];
		const category = str(v.category);
		return [
			{
				source: 'rewards',
				source_id: id(v.id),
				account_id: null,
				date: date(e.event_date ?? e.posted_date),
				amount,
				balanceAmount: null,
				category,
				categoryKind: categoryKind(category),
				fundedBy: id(unitOf.get(str(e.component_id))),
				standalone: true,
				synthetic: false,
				internal: false,
				excluded: false
			}
		];
	});
}

const ASSET_KINDS = ['security_deposit'];

/** Map Soma noncash assets onto balance-only ledgers and mark the principal
 * their events link inside raw rows or owned shares, so flows leave only that out.
 * refundablePrincipal validates the whole history; evidence keys never leave here. */
function noncashAssets(
	t: EstateTables,
	txnByKey: Map<string, Txn>,
	shareById: Map<string, { parent: string; share: TxnShare }>,
	accountOf: Map<string, Account>
): { assets: Account[]; ledger: Txn[] } {
	const assets: Account[] = (t.assets ?? []).filter(live).map((r) => {
		if (!ASSET_KINDS.includes(str(r.kind))) throw new Error('Invalid noncash asset kind');
		return {
			id: id(r.id),
			bank: id(r.name),
			name: str(r.name),
			type: str(r.kind) as AccountType,
			currency: str(r.currency),
			closed: false
		};
	});
	const currencyOf = new Map(assets.map((a) => [a.id, a.currency!]));
	const evidence = new Map<string, string>();
	for (const p of (t.asset_evidence ?? []).filter(live))
		evidence.set(str(p.to_ref), `${str(p.from_kind)}:${str(p.from_ref)}`);
	const targets = new Map<
		string,
		{ amountMinor: number; currency: string; owned: TxnShare | Txn }
	>();
	const events: PrincipalEvent[] = (t.asset_events ?? []).filter(live).map((r) => {
		let allocationId: string | null = null;
		if (r.source != null || r.source_id != null) {
			const parent = `${str(r.source)}:${str(r.source_id)}`;
			const txn = txnByKey.get(parent);
			if (!txn) throw new Error('Noncash asset leg is missing');
			const link = r.share_id == null ? undefined : shareById.get(str(r.share_id));
			if (r.share_id != null && link?.parent !== parent)
				throw new Error('Noncash asset share is not part of its leg');
			// A split row's cash belongs to its shares; never link the whole parent.
			if (r.share_id == null && txn.shares) throw new Error('Split leg needs its owned share');
			const owned = link?.share ?? txn;
			allocationId = link ? `share:${str(r.share_id)}` : `txn:${parent}`;
			targets.set(allocationId, {
				amountMinor: Math.round(owned.amount * 100),
				currency: accountOf.get(txn.account_id!)?.currency ?? '',
				owned
			});
		}
		return {
			id: id(r.id),
			assetId: str(r.asset_id),
			currency: currencyOf.get(str(r.asset_id)) ?? '',
			date: date(r.date),
			kind: str(r.kind) as PrincipalEvent['kind'],
			amountMinor: num(r.amount),
			allocationId,
			evidenceRef: evidence.get(str(r.id)) ?? ''
		};
	});
	const principal = [...currencyOf].map(([assetId, currency]) => ({ id: assetId, currency }));
	const allocations = [...targets].map(([allocationId, a]) => ({
		id: allocationId,
		currency: a.currency,
		amountMinor: a.amountMinor
	}));
	const dates = [...new Set(events.map((e) => e.date))].sort();
	const { activity } = refundablePrincipal(
		principal,
		events,
		allocations,
		dates[0] ?? '1970-01-01'
	);
	for (const [allocationId, a] of targets) {
		const linked = a.amountMinor - activity[allocationId];
		if (linked) a.owned.principal = linked / 100;
	}
	// Closing balances as of each event date become one internal ledger row per change.
	const ledger: Txn[] = [];
	const previous = new Map<string, number>();
	for (const day of dates) {
		const { balances } = refundablePrincipal(principal, events, allocations, day);
		for (const asset of assets) {
			const change = balances[asset.id] - (previous.get(asset.id) ?? 0);
			previous.set(asset.id, balances[asset.id]);
			// ponytail: dollars only, like every other balance here; other currencies stay unavailable.
			if (!change || asset.currency !== 'USD') continue;
			ledger.push({
				source: null,
				source_id: null,
				account_id: asset.id,
				date: day,
				amount: change / 100,
				balanceAmount: change / 100,
				internal: true,
				excluded: false,
				synthetic: false,
				standalone: false
			});
		}
	}
	for (const asset of assets) asset.closed = !previous.get(asset.id);
	return { assets, ledger };
}
