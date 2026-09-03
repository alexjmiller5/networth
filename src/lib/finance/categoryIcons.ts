// Category -> Tabler icon, per the house icon standard (mono UI = Tabler).
// Components render in Svelte UI (dropdown); slugs build Iconify URLs for
// the chart's canvas point styles (legend + tooltip markers).
import {
	IconBolt,
	IconBuildingStore,
	IconCashBanknote,
	IconDeviceTv,
	IconDots,
	IconHomeDollar,
	IconPackage,
	IconPercentage,
	IconPlane,
	IconShoppingCart,
	IconToolsKitchen2,
	IconTrain,
	IconTrendingUp
} from '@tabler/icons-svelte';

type IconComponent = typeof IconBolt;

const ICONS: Record<string, { component: IconComponent; slug: string }> = {
	Rent: { component: IconHomeDollar, slug: 'tabler:home-dollar' },
	Dining: { component: IconToolsKitchen2, slug: 'tabler:tools-kitchen-2' },
	Groceries: { component: IconShoppingCart, slug: 'tabler:shopping-cart' },
	'Online Shopping': { component: IconPackage, slug: 'tabler:package' },
	Travel: { component: IconPlane, slug: 'tabler:plane' },
	Transit: { component: IconTrain, slug: 'tabler:train' },
	Convenience: { component: IconBuildingStore, slug: 'tabler:building-store' },
	'Bills & Utilities': { component: IconBolt, slug: 'tabler:bolt' },
	Streaming: { component: IconDeviceTv, slug: 'tabler:device-tv' },
	Salary: { component: IconCashBanknote, slug: 'tabler:cash-banknote' },
	Interest: { component: IconPercentage, slug: 'tabler:percentage' },
	'RSU Vest': { component: IconTrendingUp, slug: 'tabler:trending-up' },
	Other: { component: IconDots, slug: 'tabler:dots' }
};

export const categoryIcon = (category: string): IconComponent | undefined =>
	ICONS[category]?.component;

/** Iconify URL for the category's icon, tinted; undefined when unmapped. */
export const categoryIconUrl = (category: string, hexColor: string): string | undefined =>
	ICONS[category]
		? `https://api.iconify.design/${ICONS[category].slug}.svg?color=${encodeURIComponent(hexColor)}`
		: undefined;
