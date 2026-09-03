export type AccountType =
	'checking' | 'savings' | 'credit_card' | 'p2p' | 'brokerage' | 'ira' | '401k';

export interface Account {
	id: string;
	bank: string;
	name: string;
	type: AccountType;
}

/** Canonical joined row the frontend consumes (raw txn + overlay applied):
 * signed amount, synthetic opening rows included, category from the overlay
 * (null = uncategorized), internal = transfer leg excluded from spending. */
export interface Txn {
	account_id: string;
	date: string; // YYYY-MM-DD
	amount: number; // signed dollars
	category?: string;
	internal?: boolean;
}

export interface PointsBalance {
	program: string;
	points: number;
	estValue: number; // dollars
}

export type GroupBy = 'account' | 'bank' | 'type' | 'category';
