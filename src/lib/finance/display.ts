import type { AccountCoverage } from './types';

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
		'verified-closed-zero': 'Verified current zero'
	};
	if (hideAmounts && coverage.status === 'verified-closed-zero')
		return {
			label: 'Verified closed account',
			details: 'Current balance verified; historical market values remain unavailable'
		};
	return { label: labels[coverage.status], details: coverage.reasons.join(' · ') };
}
