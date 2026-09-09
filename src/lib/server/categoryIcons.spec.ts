import { describe, expect, it } from 'vitest';
import { categoryIconUrl } from './categoryIcons';

describe('catalog icons', () => {
	it('resolves installed Tabler slugs without a personal category-name map or third-party requests', () => {
		const url = categoryIconUrl('tabler:home');
		expect(url).toBeTruthy();
		expect(url).not.toMatch(/^https?:/);
		expect(url).not.toBe(categoryIconUrl('tabler:bolt'));
	});
	it.each([
		'https://untrusted.example/x.svg',
		'tabler:../../x',
		'tabler:missing-icon',
		'__proto__',
		''
	])('uses an installed fallback for invalid slug %s', (value) => {
		expect(categoryIconUrl(value)).toBe(categoryIconUrl('tabler:help'));
		expect(categoryIconUrl(value)).toBeTruthy();
	});
});
