// Run against an owned synthetic browser target, never a production page:
// bun scripts/test-benefits.mjs <CDP page websocket> <local dev URL>
import assert from 'node:assert/strict';
const [socketUrl, url] = process.argv.slice(2);
if (!socketUrl || !/^http:\/\/(localhost|127\.0\.0\.1):\d+\/$/.test(url ?? '')) {
	throw new Error('Provide a CDP page websocket and a local dev URL');
}
const socket = new WebSocket(socketUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
let seq = 0;
const pending = new Map();
socket.addEventListener('message', ({ data }) => {
	const message = JSON.parse(data);
	if (message.id) {
		const callback = pending.get(message.id);
		pending.delete(message.id);
		callback?.(message);
	}
});
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++seq;
		pending.set(id, (message) => (message.error ? reject(message.error) : resolve(message.result)));
		socket.send(JSON.stringify({ id, method, params }));
	});
}
async function evaluate(expression) {
	const result = await send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true
	});
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	return result.result.value;
}
async function until(expression) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if (await evaluate(expression)) return;
		} catch (error) {
			if (!/navigated|context.*destroyed|Cannot find context/i.test(error.message ?? ''))
				throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out: ${expression}`);
}
const observation = (overrides = {}) => ({
	id: 'observation-1',
	plan_year: 2024,
	observed_at: '2024-04-06T12:00:00.000Z',
	source_as_of: '2024-04-05',
	currency: 'USD',
	annual_election: 800,
	employee_contributions: 125.5,
	claims_submitted: 300,
	claims_paid: 180,
	claims_denied: 30,
	available_benefit: 0,
	stated_notional_balance: null,
	vested_balance: null,
	eligibility_status: 'Conditional credit of 999.99 is not vested',
	vested_visibility: 'not_exposed',
	...overrides
});
const fixture = {
	plans: [
		{
			id: 'plan-1',
			provider: 'Example Benefits',
			native_plan_id: 'native-1',
			name: 'Health plan',
			kind: 'fsa',
			currency: 'USD',
			status: 'active',
			years: [
				{
					year: 2024,
					observations: [
						observation(),
						observation({
							id: 'older',
							source_as_of: '2024-04-01',
							observed_at: '2024-06-01T12:00:00.000Z'
						})
					]
				}
			]
		},
		{
			id: 'plan-2',
			provider: 'Example Benefits',
			native_plan_id: null,
			name: 'Retiree health plan',
			kind: 'retiree_health',
			currency: 'USD',
			status: 'active',
			years: [
				{
					year: null,
					observations: [
						observation({
							id: 'retiree',
							plan_year: null,
							annual_election: null,
							source_as_of: null,
							stated_notional_balance: 0,
							vested_visibility: 'suppressed'
						})
					]
				}
			]
		}
	]
};
let injection;
const errors = [];
socket.addEventListener('message', ({ data }) => {
	const m = JSON.parse(data);
	if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
});
async function click(selector) {
	await evaluate(
		`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`
	);
	const rect = await evaluate(
		`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`
	);
	for (const type of ['mousePressed', 'mouseReleased'])
		await send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...rect });
}
async function reload() {
	const old = await evaluate('performance.timeOrigin');
	await send('Page.reload');
	await until(`performance.timeOrigin!==${old} && document.querySelector('[data-benefits-ready]')`);
}
try {
	await send('Page.enable');
	await send('Runtime.enable');
	({ identifier: injection } = await send('Page.addScriptToEvaluateOnNewDocument', {
		source: `
  if(!localStorage.getItem('benefits-test-seeded')){localStorage.setItem('networth-ui',JSON.stringify({hideAmounts:true,activePreset:'ALL',futureField:12}));localStorage.setItem('benefits-test-seeded','1');}
  const initiallyHidden=JSON.parse(localStorage.getItem('networth-ui')).hideAmounts;
  window.__privacyFlash=false;
  new MutationObserver(()=>{if(initiallyHidden && !window.__allowAmounts && /800.00|125.50|999.99/.test(document.body?.innerText??''))window.__privacyFlash=true;}).observe(document,{childList:true,subtree:true,characterData:true});
  const originalFetch=window.fetch;
  window.fetch=async(input,options)=>{const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
   if(!path.startsWith('/api/'))return originalFetch(input,options);
   if(options?.method&&options.method!=='GET')throw new Error('Synthetic test forbids writes');
   if(path==='/api/finance')return Response.json({accounts:[],txns:[],categories:[],points:[],coverage:[]});
   if(path!=='/api/benefits')throw new Error('Synthetic test forbids other API calls');
   if(window.__failRefresh)return new Response('unavailable',{status:503});
   return Response.json(window.__emptyBenefits?{plans:[]}:${JSON.stringify(fixture)});
  };`
	}));
	await send('Emulation.setDeviceMetricsOverride', {
		width: 1200,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false
	});
	await send('Page.navigate', { url: new URL('/benefits', url).href });
	await until("document.querySelector('[data-benefits-ready]')");
	assert.equal(
		await evaluate('window.__privacyFlash'),
		false,
		'saved privacy has no amount/prose flash'
	);
	assert.equal(await evaluate('/800.00|125.50|999.99/.test(document.body.innerText)'), false);
	assert.equal(
		await evaluate(
			"document.querySelector('[data-benefit-metric=available_benefit]').textContent.includes('Hidden')"
		),
		true
	);
	await evaluate('window.__allowAmounts=true');
	await click('[aria-label="Show amounts"]');
	await until(
		"document.querySelector('[data-benefit-metric=annual_election]').textContent.includes('$800.00')"
	);
	assert.equal(
		await evaluate(
			"document.querySelector('[data-benefit-metric=available_benefit]').textContent.includes('$0.00')"
		),
		true
	);
	assert.equal(
		await evaluate(
			"document.querySelector('[data-plan-id=\"plan-2\"] [data-benefit-metric=vested_balance]').textContent.includes('Suppressed by provider')"
		),
		true
	);
	assert.equal(await evaluate("document.body.innerText.includes('Source as of unknown')"), true);
	assert.equal(await evaluate("JSON.parse(localStorage.getItem('networth-ui')).futureField"), 12);
	await reload();
	assert.equal(
		await evaluate('document.querySelector(\'[aria-label="Hide amounts"]\')!==null'),
		true
	);
	await click('details summary');
	assert.equal(
		await evaluate("document.querySelector('details[open]').innerText.includes('2024-04-01')"),
		true
	);
	await click('[aria-label="Hide amounts"]');
	await reload();
	assert.equal(await evaluate('window.__privacyFlash'), false);
	assert.equal(await evaluate('/800.00|125.50|999.99/.test(document.body.innerText)'), false);
	console.log(
		'PASS: native metrics, zero/unavailable/suppressed, dates, history and persisted privacy'
	);

	await click('a[href="/"]');
	await until("location.pathname==='/' && document.querySelector('[aria-label=\"View\"]')");
	const beforeNavigation = await evaluate("JSON.parse(localStorage.getItem('networth-ui'))");
	assert.equal(beforeNavigation.hideAmounts, true);
	assert.equal(beforeNavigation.activePreset, 'ALL');
	await until('document.querySelector(\'a[href="/benefits"]\')');
	await click('a[href="/benefits"]');
	await until(
		"location.pathname==='/benefits' && document.querySelector('[aria-label=\"Show amounts\"]')"
	);
	assert.equal(await evaluate('/800.00|125.50|999.99/.test(document.body.innerText)'), false);
	await click('a[href="/"]');
	await until("location.pathname==='/' && document.querySelector('[aria-label=\"View\"]')");
	assert.deepEqual(
		await evaluate("JSON.parse(localStorage.getItem('networth-ui'))"),
		beforeNavigation
	);
	await click('a[href="/benefits"]');
	await until("document.querySelector('[data-benefits-ready]')");
	console.log('PASS: trusted home/benefits navigation preserves filters and concealment');
	await send('Emulation.setDeviceMetricsOverride', {
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		mobile: true
	});
	await until('document.documentElement.scrollWidth<=innerWidth');
	const shot = await send('Page.captureScreenshot', { format: 'png' });
	if (process.env.BENEFITS_SCREENSHOT)
		await Bun.write(process.env.BENEFITS_SCREENSHOT, Buffer.from(shot.data, 'base64'));
	await evaluate('window.__failRefresh=true');
	await click('[aria-label="Reload benefits"]');
	await until("document.querySelector('[role=alert]')");
	assert.equal(
		await evaluate("document.querySelectorAll('[data-plan-id]').length"),
		2,
		'failed refresh retains prior observations'
	);
	await evaluate('window.__failRefresh=false;window.__emptyBenefits=true');
	await click('[aria-label="Reload benefits"]');
	await until("document.body.innerText.includes('No benefit plans available')");
	assert.deepEqual(errors, []);
	console.log('PASS: 390px layout, failed refresh, empty state, no runtime exceptions');
} finally {
	if (injection) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
	await evaluate(
		"localStorage.removeItem('networth-ui');localStorage.removeItem('benefits-test-seeded');caches.delete('dashboard-data-v1')"
	).catch(() => {});
	socket.close();
}
