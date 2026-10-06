/**
 * Shared JSON contract for finance launch transport. No routes are activated here.
 * Authentication, evidence verification, durable transitions and source writes
 * belong to their owners; these DTOs and pure helpers confer no authority.
 */
export const FINANCE_RUN_WIRE_VERSION = 1;
export const FINANCE_HOST_PREFIX = '/api/finance-host/v1';

export type CancellationState = 'none' | 'requested' | 'acknowledged';
export type CollectionState =
	'not_started' | 'running' | 'finished' | 'partial' | 'failed' | 'cancelled';
export type TransportState =
	'queued' | 'claimed' | 'starting' | 'recovery_required' | 'unavailable' | 'ready';
export type ReviewState = 'not_started' | 'pending' | 'completed';
export type ReservationState = 'held' | 'released';

export interface LaunchRequest {
	request_id: string;
	action: 'finance-review';
	account_ids: string[];
	tracking_task_ids: string[];
}

/** POST claims. Reuse the entire request on lost response. After an acknowledged
 * null claim, a new poll uses a new request_id. Identity is scoped to the host. */
export interface ClaimRequest {
	request_id: string;
	wait_seconds: number;
}

export interface RunClaim {
	run_id: string;
	host_id: string;
	/** Opaque server-issued identity, NOT an incrementable client counter. */
	lease_generation: string;
	revision: number;
	account_ids: string[];
	tracking_task_ids: string[];
	domain_id: string;
	cancellation: CancellationState;
	capture_closed: boolean;
}
export interface ClaimResponse {
	claim: RunClaim | null;
}

/** Verified means the service verified the referenced proof, not that the
 * reporter asserted a boolean. Missing native/client/context support is unavailable. */
export type CapabilityCheck =
	| { state: 'unavailable'; reason: string }
	| { state: 'verified'; evidence_ref: string; checked_at: string };
export interface RunReadiness {
	native_identity: CapabilityCheck;
	user_reachability: CapabilityCheck;
	collector_context: CapabilityCheck;
	source_controls: CapabilityCheck;
}

/** GET runs/{encoded run_id}/control; no cached/offline control grants a unit. */
export interface RunControl extends RunClaim {
	transport: TransportState;
	collection: CollectionState;
	review: ReviewState;
	reservation: ReservationState;
	eligibility: { state: 'eligible' | 'drifted' | 'unknown'; checked_at: string | null };
	readiness: RunReadiness;
	start_instruction_id: string | null;
	/** Next unconsumed event slot; starts at 1, independent of snapshot revision. */
	next_sequence: number;
}

export interface ConversationReceipt {
	host_id: string;
	herdr_server: string;
	workspace_id: string;
	tab_id: string;
	pane_id: string;
	terminal_id: string;
	agent_kind: 'claude' | 'codex';
	native_session: { kind: 'claude' | 'codex'; value: string; source: string } | null;
	/** Display/recovery only. Never execute browser-supplied argv. */
	resume_argv: string[] | null;
	reachability: CapabilityCheck;
}

export type AccountState =
	'pending' | 'collecting' | 'access_needed' | 'reconciled' | 'partial' | 'failed' | 'cancelled';
export interface AccountProgress {
	account_id: string;
	source: string;
	state: AccountState;
	/** Exact existing source receipts bound to THIS capture, not latest siblings. */
	source_receipt_ids: string[];
	observed_at: string | null;
	coverage_start: string | null;
	coverage_end: string | null;
	balance_basis: 'posted' | 'posted_and_pending' | 'unknown';
	cash_gate: 'verified' | 'unverified' | 'unknown';
	units_gate: 'verified' | 'unverified' | 'unknown';
	evidence_refs: string[];
	unresolved_reason: string | null;
}

/** All payloads are metadata. No raw financial records, transcript or secrets.
 * The receiver validates evidence and allowed transitions, not just this shape. */
export interface RunEventPayloads {
	run_observed: {
		transport: Exclude<TransportState, 'queued'>;
		conversation: ConversationReceipt | null;
		readiness: RunReadiness;
	};
	account_observed: AccountProgress;
	capture_finished: {
		result: Exclude<CollectionState, 'not_started' | 'running'>;
		finished_at: string;
		sync: 'unknown' | 'pending' | 'verified' | 'failed';
	};
	capture_released: {
		acknowledgment_kind: 'collector_quiescent' | 'host_prestart_quiescent';
		collection_stopped: true;
		browser_resources_released: true;
	};
	review_observed: { state: Exclude<ReviewState, 'not_started'> };
}

/** POST runs/{encoded run_id}/events. Persist exact envelope before sending.
 * Same event identity/digest returns the original decision; do not rewrite it. */
export type RunEvent = {
	[K in keyof RunEventPayloads]: {
		event_id: string;
		sequence: number;
		expected_revision: number;
		lease_generation: string;
		kind: K;
		payload: RunEventPayloads[K];
	};
}[keyof RunEventPayloads];

export type EventRejectionReason =
	| 'revision_conflict'
	| 'invalid_transition'
	| 'scope_mismatch'
	| 'invalid_evidence'
	| 'capture_closed'
	| 'cancel_requested';

/** HTTP 200 for either durable decision. Both consume this exact sequence;
 * rejected_not_applied does NOT change domain state/revision. Replays retain
 * original revision/digest even if the current control snapshot has advanced.
 * Auth/binding failures and gaps are WireError, never a consumed decision. */
export type EventDecision = {
	event_id: string;
	lease_generation: string;
	sequence: number;
	consumed_sequence: number;
	/** SHA-256 of canonical ORIGINAL request, never of this receipt. */
	decision_digest: string;
	revision: number;
} & (
	| { outcome: 'applied'; reason: null }
	| { outcome: 'rejected_not_applied'; reason: EventRejectionReason }
);

/** POST runs/{encoded run_id}/start. Distinct from poll/request/event identities. */
export interface StartRequest {
	instruction_id: string;
	expected_revision: number;
	lease_generation: string;
}
export type StartRejectionReason =
	| 'revision_conflict'
	| 'not_ready'
	| 'scope_drifted'
	| 'cancel_requested'
	| 'capture_closed'
	| 'start_already_authorized';
export type StartDecision = {
	instruction_id: string;
	lease_generation: string;
	revision: number;
	/** SHA-256 of canonical ORIGINAL request, never of this receipt. */
	decision_digest: string;
} & (
	| { outcome: 'authorized'; authorization_id: string; reason: null }
	| { outcome: 'rejected_not_authorized'; authorization_id: null; reason: StartRejectionReason }
);
// Replaying start reconciles the original decision only. Even an authorized
// receipt never licenses a second prompt: the host's instruction journal owns
// at-most-one attempted delivery and parks ambiguous outcomes for recovery.

export type CancelAcknowledgment =
	'server_unclaimed' | 'host_prestart_quiescent' | 'collector_quiescent';
export interface CancelResponse {
	run_id: string;
	revision: number;
	cancellation: Exclude<CancellationState, 'none'>;
	acknowledgment_kind: CancelAcknowledgment | null;
	capture_closed: boolean;
}

/** No account/session details on a foreign-principal domain_busy response.
 * No control/evidence fields on authentication or binding failures. */
export type WireError =
	| {
			error: {
				code:
					| 'unauthenticated'
					| 'forbidden'
					| 'not_found'
					| 'invalid_request'
					| 'domain_busy'
					| 'idempotency_conflict'
					| 'event_conflict'
					| 'lease_mismatch'
					| 'unsupported';
			};
	  }
	| { error: { code: 'sequence_gap'; expected_next_sequence: number } };

export const WIRE_LIMITS = { id_bytes: 256, scope_items: 256, max_wait_seconds: 25 } as const;
const encoder = new TextEncoder();

function invalid(): never {
	throw new Error('Invalid finance run message');
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
		return invalid();
	return record;
}
function id(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		/[\u0000-\u001f\u007f]/u.test(value) ||
		encoder.encode(value).length > WIRE_LIMITS.id_bytes
	)
		return invalid();
	// TextEncoder replaces lone surrogates; reject instead of collapsing identity.
	if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoder.encode(value)) !== value)
		return invalid();
	return value;
}
function ids(value: unknown): string[] {
	if (!Array.isArray(value) || !value.length || value.length > WIRE_LIMITS.scope_items)
		return invalid();
	const result = value.map(id);
	if (new Set(result).size !== result.length) return invalid();
	return result;
}
function integer(value: unknown, minimum = 0): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		Object.is(value, -0) ||
		value < minimum
	)
		return invalid();
	return value;
}
export function parseLaunchRequest(value: unknown): LaunchRequest {
	const record = object(value, ['request_id', 'action', 'account_ids', 'tracking_task_ids']);
	if (record.action !== 'finance-review') return invalid();
	return {
		request_id: id(record.request_id),
		action: record.action,
		account_ids: ids(record.account_ids),
		tracking_task_ids: ids(record.tracking_task_ids)
	};
}
export function parseClaimRequest(value: unknown): ClaimRequest {
	const record = object(value, ['request_id', 'wait_seconds']);
	const wait = integer(record.wait_seconds);
	if (wait > WIRE_LIMITS.max_wait_seconds) return invalid();
	return { request_id: id(record.request_id), wait_seconds: wait };
}
export function parseStartRequest(value: unknown): StartRequest {
	const record = object(value, ['instruction_id', 'expected_revision', 'lease_generation']);
	return {
		instruction_id: id(record.instruction_id),
		expected_revision: integer(record.expected_revision),
		lease_generation: id(record.lease_generation)
	};
}

function byteOrder(left: string, right: string): number {
	const a = encoder.encode(left),
		b = encoder.encode(right);
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}
/** request_id is the lookup key, not part of its payload digest. Perform that
 * authenticated lookup before mutable registry checks on a NEW request only. */
export function canonicalLaunchRequest(value: unknown): string {
	const request = parseLaunchRequest(value);
	return JSON.stringify({
		action: request.action,
		account_ids: request.account_ids.sort(byteOrder),
		tracking_task_ids: request.tracking_task_ids.sort(byteOrder)
	});
}
export async function launchRequestDigest(value: unknown): Promise<string> {
	const bytes = await crypto.subtle.digest(
		'SHA-256',
		encoder.encode(canonicalLaunchRequest(value))
	);
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Canonical ORIGINAL RunEvent or StartRequest for decision_digest:
 * SHA-256 UTF-8, lowercase hex; recursively sort object keys by UTF-8 bytes,
 * compact JSON, preserve array order and Unicode without normalization/ASCII
 * escaping. JSON string escaping follows JSON.stringify (including controls).
 * Numbers must be safe integers, never floats, nonfinite values or negative zero.
 * No omitted/undefined fields, non-JSON objects or malformed Unicode. Receivers
 * must separately validate the envelope schema and reject duplicate JSON keys.
 * Python equivalent for validated JSON: json.dumps(value, sort_keys=True,
 * ensure_ascii=False, separators=(',', ':')).encode('utf-8').
 * Receipt replay returns the ORIGINAL receipt including revision and digest.
 */
export function canonicalDecisionRequest(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || Object.is(value, -0)) return invalid();
		return String(value);
	}
	if (typeof value === 'string') {
		if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoder.encode(value)) !== value)
			return invalid();
		return JSON.stringify(value);
	}
	if (Array.isArray(value))
		return '[' + Array.from(value, canonicalDecisionRequest).join(',') + ']';
	if (
		!value ||
		typeof value !== 'object' ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		return invalid();
	const record = value as Record<string, unknown>;
	return (
		'{' +
		Object.keys(record)
			.sort(byteOrder)
			.map((key) => canonicalDecisionRequest(key) + ':' + canonicalDecisionRequest(record[key]))
			.join(',') +
		'}'
	);
}
export async function decisionRequestDigest(value: unknown): Promise<string> {
	const bytes = await crypto.subtle.digest(
		'SHA-256',
		encoder.encode(canonicalDecisionRequest(value))
	);
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function parseEventDecision(value: unknown): EventDecision {
	const record = object(value, [
		'event_id',
		'lease_generation',
		'sequence',
		'consumed_sequence',
		'decision_digest',
		'revision',
		'outcome',
		'reason'
	]);
	const sequence = integer(record.sequence, 1);
	if (
		record.consumed_sequence !== sequence ||
		typeof record.decision_digest !== 'string' ||
		!/^[a-f0-9]{64}$/.test(record.decision_digest)
	)
		return invalid();
	const base = {
		event_id: id(record.event_id),
		lease_generation: id(record.lease_generation),
		sequence,
		consumed_sequence: sequence,
		decision_digest: record.decision_digest,
		revision: integer(record.revision)
	};
	if (record.outcome === 'applied' && record.reason === null)
		return { ...base, outcome: 'applied', reason: null };
	const reasons: EventRejectionReason[] = [
		'revision_conflict',
		'invalid_transition',
		'scope_mismatch',
		'invalid_evidence',
		'capture_closed',
		'cancel_requested'
	];
	if (
		record.outcome !== 'rejected_not_applied' ||
		!reasons.includes(record.reason as EventRejectionReason)
	)
		return invalid();
	return {
		...base,
		outcome: 'rejected_not_applied',
		reason: record.reason as EventRejectionReason
	};
}

/** Pure prerequisite check on an authenticated, validated, current snapshot.
 * The service must still atomically recheck evidence, reservation and revisions.
 * This never constitutes start authorization or permission to send a prompt. */
export function isStartReady(control: RunControl): boolean {
	return (
		control.transport === 'ready' &&
		control.collection === 'not_started' &&
		control.reservation === 'held' &&
		control.cancellation === 'none' &&
		!control.capture_closed &&
		control.start_instruction_id === null &&
		control.eligibility.state === 'eligible' &&
		control.readiness.native_identity.state === 'verified' &&
		control.readiness.user_reachability.state === 'verified' &&
		control.readiness.collector_context.state === 'verified' &&
		control.readiness.source_controls.state === 'verified'
	);
}
