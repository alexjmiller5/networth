// Deterministic mock estate for the chart prototype - shaped like the real
// data contract (accounts registry + canonical joined txns incl. synthetic
// openings, categories, internal-transfer legs). Deleted once real life-data
// feeds the app.

import type { Account, PointsBalance, Txn } from './types';

export const MOCK_ACCOUNTS: Account[] = [
	{
		id: 'checking',
		bank: 'First Federal',
		name: 'Everyday Checking',
		type: 'checking'
	},
	{ id: 'savings', bank: 'Northwind Savings', name: 'High-Yield Savings', type: 'savings' },
	{ id: 'venmo', bank: 'Venmo', name: 'Venmo Balance', type: 'p2p' },
	{ id: 'travel-card', bank: 'First Federal', name: 'Travel Card', type: 'credit_card' },
	{ id: 'cashback-card', bank: 'First Federal', name: 'Cash Back Card', type: 'credit_card' },
	{ id: 'rent-card', bank: 'Homestead Bank', name: 'Rent Card', type: 'credit_card' },
	{ id: 'roth-ira', bank: 'First Federal', name: 'Roth IRA', type: 'ira' },
	{ id: 'managed-brokerage', bank: 'First Federal', name: 'Managed Brokerage', type: 'brokerage' },
	{ id: 'brokerage', bank: 'Sterling Invest', name: 'Brokerage', type: 'brokerage' },
	{ id: 'retirement-401k', bank: 'Vantage Retirement', name: '401(k)', type: '401k' }
];

export const MOCK_POINTS: PointsBalance[] = [
	{ program: 'Rent Rewards', points: 24150, estValue: 302 },
	{ program: 'Skyward Air', points: 31400, estValue: 408 },
	{ program: 'Northern Air', points: 12800, estValue: 154 },
	{ program: 'Rail Miles', points: 6200, estValue: 155 },
	{ program: 'Burrito Club', points: 1180, estValue: 12 }
];

/** mulberry32 - tiny seeded PRNG so the mock renders identically every load. */
function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const DAY = 86_400_000;

export function generateMockTxns(start = '2024-09-01', end = '2026-09-01'): Txn[] {
	const rand = rng(20260902);
	const txns: Txn[] = [];
	const push = (
		account_id: string,
		t: number,
		amount: number,
		category?: string,
		internal?: boolean
	) =>
		txns.push({
			account_id,
			date: new Date(t).toISOString().slice(0, 10),
			amount,
			category,
			internal
		});

	const t0 = Date.parse(start);
	const t1 = Date.parse(end);

	// synthetic openings (internal - not spending)
	push('checking', t0, 4200, undefined, true);
	push('savings', t0, 14000, undefined, true);
	push('venmo', t0, 120, undefined, true);
	push('roth-ira', t0, 7600, undefined, true);
	push('managed-brokerage', t0, 11500, undefined, true);
	push('brokerage', t0, 5200, undefined, true);
	push('retirement-401k', t0, 26500, undefined, true);

	// daily card spend: (card, category, chance, min, spread)
	const spend: [string, string, number, number, number][] = [
		['travel-card', 'Dining', 0.5, 14, 70],
		['travel-card', 'Travel', 0.04, 80, 400],
		['rent-card', 'Dining', 0.25, 12, 55],
		['cashback-card', 'Groceries', 0.3, 20, 90],
		['cashback-card', 'Online Shopping', 0.18, 15, 120],
		['cashback-card', 'Convenience', 0.22, 5, 25],
		['travel-card', 'Transit', 0.55, 2.9, 6]
	];

	const owed: Record<string, number> = { 'travel-card': 0, 'cashback-card': 0, 'rent-card': 0 };
	let payday = 0;
	for (let t = t0 + DAY; t <= t1; t += DAY) {
		const d = new Date(t);
		const dom = d.getUTCDate();
		const dow = d.getUTCDay();

		// biweekly paycheck friday: net pay to checking, 401k deferral + match
		if (dow === 5 && ++payday % 2 === 0) {
			push('checking', t, 2750 + Math.round(rand() * 60), 'Salary');
			push('retirement-401k', t, 610, 'Salary');
		}
		// rent on the 1st (paid on the rent card for points)
		if (dom === 1) {
			push('rent-card', t, -2350, 'Rent');
			owed['rent-card'] += 2350;
		}
		// card swipes
		for (const [card, category, chance, min, range] of spend) {
			if (rand() < chance) {
				const amt = Math.round((min + rand() * range) * 100) / 100;
				push(card, t, -amt, category);
				owed[card] += amt;
			}
		}
		// monthly bills + streaming from checking
		if (dom === 3) push('checking', t, -120 - Math.round(rand() * 40), 'Bills & Utilities');
		if (dom === 6) push('checking', t, -32, 'Streaming');
		// card autopay on the 5th: both legs internal (moving money, not spending)
		if (dom === 5) {
			for (const card of Object.keys(owed)) {
				if (owed[card] > 0) {
					const pay = Math.round(owed[card] * 100) / 100;
					push(card, t, pay, undefined, true);
					push('checking', t, -pay, undefined, true);
					owed[card] = 0;
				}
			}
		}
		// venmo churn
		if (rand() < 0.12) push('venmo', t, Math.round((rand() - 0.45) * 180));
		// monthly savings sweep on the 15th + interest end of month
		if (dom === 15) {
			push('checking', t, -500, undefined, true);
			push('savings', t, 500, undefined, true);
		}
		if (dom === 28)
			push('savings', t, Math.round((14000 + (t - t0) / DAY) * 0.0036), 'Interest');
		// quarterly RSU vest to the brokerage
		if (dom === 15 && [2, 5, 8, 11].includes(d.getUTCMonth())) {
			push('brokerage', t, 1400 + Math.round(rand() * 300), 'RSU Vest');
		}
		// market drift on investment accounts (weekly, mildly upward, noisy)
		if (dow === 1) {
			for (const [id, base] of [
				['roth-ira', 8000],
				['managed-brokerage', 12000],
				['brokerage', 6000],
				['retirement-401k', 30000]
			] as const) {
				push(id, t, Math.round(base * (0.0021 + (rand() - 0.48) * 0.012)));
			}
		}
	}
	return txns;
}
