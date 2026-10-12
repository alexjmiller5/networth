import { describe, expect, it } from 'vitest';
import { OWN, categoryTree, drillKey, levelKeys, lineage, ownerOf } from './categoryTree';
import type { Category } from './types';

const cat = (id: string, name: string, sort: number, parentId?: string): Category => ({
	id,
	name,
	kind: 'spending',
	icon: 'tabler:tag',
	sort,
	...(parentId ? { parentId } : {})
});
const categories = [
	cat('trains', 'Trains', 14, 'travel'),
	cat('travel', 'Travel', 10),
	cat('airfare', 'Airfare', 12, 'travel'),
	cat('dining', 'Dining', 30),
	cat('jobs', 'Jobs', 300),
	cat('co', 'Employer', 301, 'jobs'),
	cat('k', '401(k)', 302, 'co')
];
const tree = categoryTree(categories);

describe('category tree', () => {
	it('walks a category up to its root, nesting to any depth', () => {
		expect(lineage(tree, 'k').map((c) => c.id)).toEqual(['jobs', 'co', 'k']);
		expect(lineage(tree, 'dining').map((c) => c.id)).toEqual(['dining']);
	});

	it('stops at unknown parents and cycles instead of looping', () => {
		const broken = categoryTree([
			cat('a', 'A', 1, 'b'),
			cat('b', 'B', 2, 'a'),
			cat('c', 'C', 3, 'x')
		]);
		expect(lineage(broken, 'a').map((c) => c.id)).toEqual(['b', 'a']);
		expect(lineage(broken, 'c').map((c) => c.id)).toEqual(['c']);
	});

	it('rolls every row up to its top-level ancestor at the top level', () => {
		expect(drillKey(tree, '', 'Trains')).toBe('Travel');
		expect(drillKey(tree, '', 'Travel')).toBe('Travel');
		expect(drillKey(tree, '', '401(k)')).toBe('Jobs');
		expect(drillKey(tree, '', 'Uncatalogued')).toBe('Uncatalogued');
	});

	it('shows a parent its children, its own rows under a separate key, and nothing else', () => {
		expect(drillKey(tree, 'travel', 'Trains')).toBe('Trains');
		expect(drillKey(tree, 'travel', 'Travel')).toBe(`Travel${OWN}`);
		expect(drillKey(tree, 'travel', 'Dining')).toBeNull();
		expect(drillKey(tree, 'jobs', '401(k)')).toBe('Employer');
		expect(drillKey(tree, 'co', '401(k)')).toBe('401(k)');
		expect(drillKey(tree, 'travel', 'Uncatalogued')).toBeNull();
	});

	it('lists a level in catalog order with the own key only when the parent has direct rows', () => {
		expect(levelKeys(tree, '', new Set())).toEqual(['Travel', 'Dining', 'Jobs']);
		expect(levelKeys(tree, 'travel', new Set())).toEqual(['Airfare', 'Trains']);
		expect(levelKeys(tree, 'travel', new Set(['Travel']))).toEqual([
			'Airfare',
			'Trains',
			`Travel${OWN}`
		]);
	});

	it('maps an own key back to the category that owns its color and icon', () => {
		expect(ownerOf(`Travel${OWN}`)).toBe('Travel');
		expect(ownerOf('Trains')).toBe('Trains');
	});
});
