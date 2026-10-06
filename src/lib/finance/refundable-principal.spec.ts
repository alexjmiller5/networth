import { describe, expect, it } from 'vitest';
import { refundablePrincipal, type PrincipalEvent } from './refundable-principal';

const assets = [{ id: 'asset-1', currency: 'USD' }];
const allocations = [
	{ id: 'share-fund', currency: 'USD', amountMinor: -12000 },
	{ id: 'share-refund', currency: 'USD', amountMinor: 10500 },
	{ id: 'share-sale', currency: 'USD', amountMinor: 2500 }
];
const events: PrincipalEvent[] = [
	{
		id: 'event-fund',
		assetId: 'asset-1',
		currency: 'USD',
		date: '2030-01-01',
		kind: 'fund',
		amountMinor: 10000,
		allocationId: 'share-fund',
		evidenceRef: 'evidence-1'
	},
	{
		id: 'event-refund',
		assetId: 'asset-1',
		currency: 'USD',
		date: '2030-03-01',
		kind: 'refund',
		amountMinor: 10000,
		allocationId: 'share-refund',
		evidenceRef: 'evidence-2'
	}
];
const calculate = (rows = events, date = '2030-03-01', owned = allocations) =>
	refundablePrincipal(assets, rows, owned, date);

describe('refundable principal', () => {
	it('removes only linked principal from mixed allocations, preserving unrelated sale and fee flows', () => {
		expect(calculate()).toEqual({
			balances: { 'asset-1': 0 },
			activity: { 'share-fund': -2000, 'share-refund': 500, 'share-sale': 2500 }
		});
		expect(calculate(events, '2030-02-01').balances).toEqual({ 'asset-1': 10000 });
		expect(calculate(events, '2029-12-31').balances).toEqual({ 'asset-1': 0 });
		expect(calculate(events, '2029-12-31').activity).toEqual(calculate().activity);
	});
	it('rejects cumulative principal beyond safe minor-unit precision', () => {
		const huge = Number.MAX_SAFE_INTEGER;
		expect(() =>
			calculate(
				[
					{ ...events[0], amountMinor: huge },
					{ ...events[0], id: 'event-extra', allocationId: 'share-extra', amountMinor: 1 }
				],
				undefined,
				[
					{ ...allocations[0], amountMinor: -huge },
					{ ...allocations[0], id: 'share-extra', amountMinor: -1 }
				]
			)
		).toThrow(/precision/i);
	});
	it('retains remaining principal after partial refund and evidenced forfeiture without a bank row', () => {
		const partial = { ...events[1], amountMinor: 3000 };
		const forfeit: PrincipalEvent = {
			...partial,
			id: 'event-forfeit',
			kind: 'forfeit',
			amountMinor: 2000,
			allocationId: null
		};
		expect(calculate([events[0], partial, forfeit]).balances['asset-1']).toBe(5000);
		expect(calculate([events[0], partial, forfeit]).activity['share-refund']).toBe(7500);
	});
	it('rejects refunds exceeding principal at any dated boundary even if later funded', () => {
		expect(() => calculate([{ ...events[0], date: '2030-04-01' }, events[1]])).toThrow(
			/principal/i
		);
		expect(() => calculate([{ ...events[0], amountMinor: 9000 }, events[1]])).toThrow(/principal/i);
	});
	it('is independent of input order for simultaneous funding and refund', () => {
		const sameDay = [{ ...events[1], date: events[0].date }, events[0]];
		expect(calculate(sameDay).balances['asset-1']).toBe(0);
	});
	it('rejects over-allocation across assets and never mutates its inputs', () => {
		const before = JSON.stringify({ events, allocations });
		calculate();
		expect(JSON.stringify({ events, allocations })).toBe(before);
		expect(() =>
			refundablePrincipal(
				[...assets, { id: 'asset-2', currency: 'USD' }],
				[events[0], { ...events[0], id: 'event-other', assetId: 'asset-2', amountMinor: 3000 }],
				allocations,
				'2030-01-01'
			)
		).toThrow(/allocation/i);
	});
	it.each([
		{ date: '2030-02-30' },
		{ amountMinor: 0 },
		{ amountMinor: -1 },
		{ amountMinor: 0.5 },
		{ amountMinor: Number.MAX_SAFE_INTEGER + 1 },
		{ allocationId: null },
		{ allocationId: 'missing' },
		{ assetId: 'missing' },
		{ currency: 'EUR' },
		{ evidenceRef: '' }
	])('rejects invalid funding input %j', (patch) => {
		expect(() => calculate([{ ...events[0], ...patch }])).toThrow();
	});
	it('rejects wrong allocation sign and currency, without inferring FX', () => {
		expect(() =>
			calculate([events[0]], undefined, [{ ...allocations[0], amountMinor: 12000 }])
		).toThrow(/sign/i);
		expect(() =>
			calculate([events[0]], undefined, [{ ...allocations[0], currency: 'EUR' }])
		).toThrow(/currency/i);
	});
	it('rejects duplicate stable identities and forged forfeiture cash links', () => {
		expect(() => calculate([events[0], events[0]])).toThrow(/duplicate/i);
		expect(() => calculate(events, undefined, [...allocations, allocations[0]])).toThrow(
			/duplicate/i
		);
		expect(() => calculate([events[0], { ...events[1], kind: 'forfeit' }])).toThrow(/allocation/i);
		expect(() => calculate(events, '2030-02-30')).toThrow(/date/i);
	});
});
