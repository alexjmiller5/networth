export type AccountType =
	| 'checking'
	| 'savings'
	| 'credit_card'
	| 'p2p'
	| 'brokerage'
	| 'ira'
	| '401k'
	| 'cash'
	| 'stored_value'
	/** A noncash refundable asset (Soma `assets.kind`), never a bank account. */
	| 'security_deposit';

export interface Account {
	id: string;
	bank: string;
	name: string;
	type: AccountType;
	source?: string;
	currency?: string;
	closed?: boolean;
	/** Prior names in chronological order; until is exclusive. */
	nameHistory?: { name: string; until: string }[];
	logo?: string;
}

export type CategoryKind = 'spending' | 'income' | 'transfer' | 'unknown';

export interface Category {
	id: string;
	name: string;
	kind: CategoryKind;
	icon: string;
	/** Optional API enrichment for rendering the catalog icon. */
	iconUrl?: string;
	sort: number;
}

export interface AccountCoverage {
	account_id: string;
	status: 'verified' | 'unverified' | 'missing' | 'investment-unvalued' | 'verified-closed-zero';
	/** Verified current flat investment only; never a historical price series. */
	currentBalance?: 0;
	basis: 'money' | 'units' | 'none';
	asOf: string | null;
	firstTransaction: string | null;
	lastTransaction: string | null;
	transactionCount: number;
	reasons: string[];
}

/** One person's piece of a shared charge (the estate's `shares` table). */
export interface TxnShare {
	date?: string;
	amount: number; // signed like the parent, never larger
	category: string;
	categoryKind?: CategoryKind;
	/** Signed principal of this share linked to a noncash asset; flows leave it out. */
	principal?: number;
}

export interface Txn {
	source?: string | null;
	source_id?: string | null;
	account_id: string | null;
	date: string; // YYYY-MM-DD
	amount: number; // signed dollars
	/** Balance effect, distinct from spending. Null means unavailable, never zero. */
	balanceAmount?: number | null;
	category?: string;
	categoryKind?: CategoryKind;
	status?: string;
	synthetic?: boolean;
	qty?: number;
	ticker?: string;
	internal?: boolean;
	/** Left out of spending (a reimbursed purchase, a refund leg, a settlement). Balances still count it. */
	excluded?: boolean;
	/** When present the category lives here, not on the row: flows read the shares, balances read the row. */
	shares?: TxnShare[];
	/** A share with no bank row behind it (a friend paid): spending only, no account, no balance. */
	standalone?: boolean;
	/** Native reward unit that paid for a standalone consumption row (a points-paid dinner), never cash. */
	fundedBy?: string;
	/** Signed principal of an unsplit row linked to a noncash asset; flows leave it out. */
	principal?: number;
}

export interface PointsBalance {
	program: string;
	points: number;
	estValue: number | null; // dollars; null when no estimate exists
	scrapedAt: string;
}

export type AssetClass = 'cash' | 'investments' | 'deposits';
export type GroupBy = 'account' | 'bank' | 'type' | 'asset' | 'category';
