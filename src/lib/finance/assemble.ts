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
}

export interface Estate {
	accounts: Account[];
	txns: Txn[];
	categories: Category[];
	points: PointsBalance[];
	coverage: AccountCoverage[];
}

const live = (r: HubRow): boolean => r.deleted_at == null;
const str = (v: unknown): string => (v == null ? '' : String(v));
const investment = (a: Account): boolean => ['brokerage', 'ira', '401k'].includes(a.type);

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
			currency: str(r.currency)
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
	const txnKeys = new Set<string>();
	for (const [source, rows] of Object.entries(t.txns)) {
		for (const r of rows.filter(live)) {
			const a = accountOf.get(str(r.account_id));
			if (!a || a.source !== source) throw new Error('Invalid finance account reference');
			const key = `${source}:${id(r.id)}`;
			if (txnKeys.has(key)) throw new Error('Duplicate finance transaction');
			txnKeys.add(key);
			const o = overlay.get(key);
			const amount = num(r.amount);
			const synthetic = flag(r.synthetic);
			let balanceAmount: number | null = investment(a) ? null : amount;
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
		}
	}
	if (shares.size) throw new Error('Finance share parent is missing');
	txns.push(...standalone);
	txns.sort((a, b) => a.date.localeCompare(b.date));

	const latestRun = new Map<string, HubRow>();
	for (const r of t.scrape_runs.filter(live)) {
		const prev = latestRun.get(str(r.source));
		if (!prev || str(r.finished_at) > str(prev.finished_at)) latestRun.set(str(r.source), r);
	}
	const coverage: AccountCoverage[] = accounts.map((a) => {
		const rows = txns.filter((r) => r.account_id === a.id);
		const r = latestRun.get(a.source!);
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
		} else if (investment(a)) {
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
	return { accounts, txns, categories, points, coverage };
}
