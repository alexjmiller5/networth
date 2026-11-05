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

it('excludes both average and net overlays from financial tooltip totals', async () => {
	const { tooltipTotal } = await import('./chartStyle');
	const row = (y: number, stack?: string) => ({ dataset: { stack }, parsed: { y } });
	expect(tooltipTotal([row(100), row(-20), row(80, 'net'), row(40, 'average')])).toBe(80);
});

it('keeps a rolling overlay unscaled in its wording and separate from monetary totals', async () => {
	const { rollingAverageDataset, tooltipTotal } = await import('./chartStyle');
	const overlay = rollingAverageDataset([100, null, 200], '#ffffff', '#000000');
	expect(overlay.label).toBe('14-day average');
	expect(overlay.label).not.toMatch(/equivalent/);
	expect(overlay.data).toEqual([100, null, 200]);
	expect(overlay.spanGaps).toBe(false);
	expect(
		tooltipTotal([
			{ dataset: overlay, parsed: { y: 200 } },
			{ dataset: {}, parsed: { y: 300 } }
		])
	).toBe(300);
});
it('leaves a single known rolling observation visible without bridging unknown days', async () => {
	const { rollingAverageDataset } = await import('./chartStyle');
	expect(rollingAverageDataset([null, 5, null], '#ffffff', '#000000').pointRadius).toBe(3);
	expect(rollingAverageDataset([5, 6], '#ffffff', '#000000').pointRadius).toBe(0);
});
