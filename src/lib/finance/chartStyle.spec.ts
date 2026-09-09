import { describe, expect, it } from 'vitest';
import { needsNet, colorForSlot } from './chartStyle';

describe('chart encodings', () => {
	it('adds a net overlay only where positive and negative stacks coexist', () => {
		expect(
			needsNet(
				{
					dates: ['a'],
					series: [
						{ key: 'one', data: [100] },
						{ key: 'two', data: [-30] }
					]
				},
				true
			)
		).toBe(true);
		expect(
			needsNet({
				dates: ['a'],
				series: [
					{ key: 'one', data: [100] },
					{ key: 'two', data: [-30] }
				]
			})
		).toBe(false);
		expect(
			needsNet(
				{
					dates: ['a'],
					series: [
						{ key: 'one', data: [100] },
						{ key: 'two', data: [30] }
					]
				},
				true
			)
		).toBe(false);
		expect(needsNet({ dates: ['a'], series: [{ key: 'one', data: [-100] }] }, true)).toBe(false);
	});
	it('extends the palette instead of reusing a color when all series are shown', () => {
		const palette = ['#112233', '#445566'];
		const colors = Array.from({ length: 40 }, (_, i) => colorForSlot(i, palette, 65, 45));
		expect(new Set(colors).size).toBe(40);
		expect(colorForSlot(1, palette, 65, 45)).toBe('#445566');
		expect(colorForSlot(24, palette, 65, 45)).not.toBe(colorForSlot(0, palette, 65, 45));
	});
});
