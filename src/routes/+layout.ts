// Client-only dashboard: Chart.js (and its CJS dayjs adapter) never runs in SSR,
// and app-wide (layout-level) so error pages render client-side too - a
// page-level ssr=false makes SvelteKit 500 on unknown routes instead of 404.
export const ssr = false;
