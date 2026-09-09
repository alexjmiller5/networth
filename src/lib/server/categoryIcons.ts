// The installed package is the complete icon allowlist, never user taxonomy.
// Inline SVGs keep financial views independent of third-party requests.
import installed from '../../../node_modules/@tabler/icons/tabler-nodes-outline.json' with { type: 'json' };

type Nodes = [string, Record<string, string | number>][];
const icons = installed as unknown as Record<string, Nodes>;
const urls = new Map<string, string>();
const escape = (value: string | number) =>
	String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export function categoryIconUrl(icon: string): string {
	const candidate = /^tabler:([a-z0-9-]+)$/.exec(icon)?.[1] ?? '';
	const slug = Object.hasOwn(icons, candidate) ? candidate : 'help';
	let url = urls.get(slug);
	if (!url) {
		const children = icons[slug]
			.map(
				([tag, attributes]) =>
					`<${tag} ${Object.entries(attributes)
						.map(([key, value]) => `${key}="${escape(value)}"`)
						.join(' ')}/>`
			)
			.join('');
		url = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`)}`;
		urls.set(slug, url);
	}
	return url;
}
