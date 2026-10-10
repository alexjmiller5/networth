import type { AccountCoverage } from './types';
import { navAge, type AccountValuation } from './valuation';

/** Presentation-only concealment; source values stay on the current device. */
export function formatMoney(value: number, hideAmounts: boolean): string {
	if (hideAmounts) return 'Hidden';
	return (value === 0 ? 0 : value).toLocaleString('en-US', {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: 2
	});
}
export function formatMoneyTick(value: number, hideAmounts: boolean): string {
	if (hideAmounts) return '';
	return Math.abs(value) >= 1000
		? `$${(value / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
		: formatMoney(value, false);
}
export function formatUnits(value: number, hideAmounts: boolean): string {
	return hideAmounts ? 'Hidden' : value.toLocaleString('en-US');
}

export function formatCoverage(
	coverage: AccountCoverage,
	hideAmounts: boolean
): { label: string; details: string } {
	const labels = {
		verified: 'Verified',
		unverified: 'Unverified',
		missing: 'Missing transactions',
		'investment-unvalued': 'Investment value unavailable',
		'verified-closed-zero': 'Verified current zero',
		carried: 'Carried NAV'
	};
	if (hideAmounts && coverage.status === 'verified-closed-zero')
		return {
			label: 'Verified closed account',
			details: 'Current balance verified; historical market values remain unavailable'
		};
	return { label: labels[coverage.status], details: coverage.reasons.join(' · ') };
}

/** Overview caption for an investment value on a day: its price date, plus the NAV age when carried. */
export function valuationLabel(v: AccountValuation, day: string): string | undefined {
	if (day < v.start || day > v.end) return undefined;
	const i = Math.round((Date.parse(day) - Date.parse(v.start)) / 86_400_000);
	const asOf = v.values[i] === null ? null : v.priceDates[i];
	if (!asOf) return undefined;
	return v.carried[i] ? `As of ${asOf} · NAV ${navAge(asOf, day)}` : `Market value as of ${asOf}`;
}
