// The catalog's category tree: each category has at most one parent, nested to
// any depth, and every row keeps exactly one category, so rolling rows up the
// tree never double-counts.
import type { Category } from './types';

/** Suffix of the key that holds a parent's own rows inside its breakdown. */
export const OWN = ' (other)';

export interface CategoryTree {
	byId: Map<string, Category>;
	byName: Map<string, Category>;
	/** Parent id ('' = top level) -> children in catalog order. */
	children: Map<string, Category[]>;
}

export function categoryTree(categories: Category[]): CategoryTree {
	const byId = new Map(categories.map((c) => [c.id, c]));
	const children = new Map<string, Category[]>();
	const sorted = [...categories].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
	for (const c of sorted) {
		const parent = c.parentId && byId.has(c.parentId) ? c.parentId : '';
		children.set(parent, [...(children.get(parent) ?? []), c]);
	}
	return { byId, byName: new Map(categories.map((c) => [c.name, c])), children };
}

/** Root-first chain ending at `id`. Unknown parents and cycles end the walk. */
export function lineage(tree: CategoryTree, id: string): Category[] {
	const chain: Category[] = [];
	const seen = new Set<string>();
	for (let c = tree.byId.get(id); c && !seen.has(c.id); c = tree.byId.get(c.parentId ?? '')) {
		seen.add(c.id);
		chain.unshift(c);
	}
	return chain;
}

/** The series a row filed under `name` counts toward while `node` ('' = top
 * level) is open: its top-level ancestor, the child of `node` it sits under,
 * the node's own key, or null when it lies outside the node. */
export function drillKey(tree: CategoryTree, node: string, name: string): string | null {
	const category = tree.byName.get(name);
	if (!category) return node ? null : name;
	const chain = lineage(tree, category.id);
	if (!node) return chain[0].name;
	const at = chain.findIndex((c) => c.id === node);
	if (at < 0) return null;
	return at === chain.length - 1 ? name + OWN : chain[at + 1].name;
}

/** A level's registry: the node's children in catalog order, then its own key
 * when the node itself has rows. */
export function levelKeys(tree: CategoryTree, node: string, ownRows: Set<string>): string[] {
	const keys = (tree.children.get(node) ?? []).map((c) => c.name);
	const self = tree.byId.get(node);
	return self && ownRows.has(self.name) ? [...keys, self.name + OWN] : keys;
}

/** The category whose color and icon a key wears. */
export function ownerOf(key: string): string {
	return key.endsWith(OWN) ? key.slice(0, -OWN.length) : key;
}
