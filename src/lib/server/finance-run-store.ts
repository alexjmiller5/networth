import {
	canonicalLaunchRequest,
	decisionRequestDigest,
	launchRequestDigest,
	parseClaimRequest,
	parseLaunchRequest,
	type CancelResponse,
	type ClaimResponse,
	type RunClaim,
	type WireError
} from '../finance/run-contract.ts';

/** A real adapter must serialize writers and atomically commit or roll back this
 * synchronous callback. This is NOT the D1 prepare/batch interface. */
export interface RunSql {
	get<T>(sql: string, ...bindings: (string | number | null)[]): T | null;
	run(sql: string, ...bindings: (string | number | null)[]): { changes: number };
}
export interface RunStorage {
	transaction<T>(operation: (sql: RunSql) => T): T;
}
export interface FrozenAccount {
	account_id: string;
	source_id: string;
}
interface HostBinding {
	principal_id: string;
	domain_id: string;
	enabled: boolean;
}
export interface RunPolicy {
	/** Service-owned physical browser domain; never taken from a launch request. */
	domainId: string;
	/** Resolve a validated, eligible registry snapshot. Called inside the synchronous transaction. */
	resolveScope?: (principalId: string, accountIds: readonly string[]) => FrozenAccount[] | null;
	/** Current enrolled-host eligibility. The route must authenticate first. */
	resolveHost?: (authenticatedHostId: string) => HostBinding | null;
	newId?: () => string;
}
export interface LaunchReceipt {
	run_id: string;
	revision: number;
}
export interface StoredRun {
	run_id: string;
	domain_id: string;
	scope: FrozenAccount[];
	tracking_task_ids: string[];
	revision: number;
	transport: 'queued' | 'claimed';
	collection: 'not_started' | 'cancelled';
	cancellation: 'none' | 'requested' | 'acknowledged';
	reservation: 'held' | 'released';
	capture_closed: boolean;
	host_id: string | null;
	lease_generation: string | null;
	host_intent_id: string | null;
}
interface RunRow extends Omit<StoredRun, 'scope' | 'tracking_task_ids' | 'capture_closed'> {
	principal_id: string;
	scope_json: string;
	task_ids_json: string;
	capture_closed: number;
}
interface ReceiptRow {
	request_digest: string;
	receipt_json: string;
	principal_id: string;
	domain_id: string;
}
const failure = (code: Exclude<WireError['error']['code'], 'sequence_gap'>): WireError => ({
	error: { code }
});
function validId(value: unknown): value is string {
	try {
		parseClaimRequest({ request_id: value, wait_seconds: 0 });
		return true;
	} catch {
		return false;
	}
}
function updated(changes: number) {
	if (changes !== 1) throw new Error('Run transaction lost its serialized update');
}
function view(row: RunRow): StoredRun {
	const { principal_id: _principal, scope_json, task_ids_json, ...rest } = row;
	return {
		...rest,
		scope: JSON.parse(scope_json),
		tracking_task_ids: JSON.parse(task_ids_json),
		capture_closed: row.capture_closed === 1
	};
}
function claimView(row: RunRow): RunClaim {
	return {
		run_id: row.run_id,
		host_id: row.host_id!,
		lease_generation: row.lease_generation!,
		revision: row.revision,
		account_ids: (JSON.parse(row.scope_json) as FrozenAccount[]).map((a) => a.account_id),
		tracking_task_ids: JSON.parse(row.task_ids_json),
		domain_id: row.domain_id,
		cancellation: row.cancellation,
		capture_closed: row.capture_closed === 1
	};
}

/** Durable lifecycle foundation only. No start, events, native launch, lease
 * takeover, readiness assertion, or claimed-reservation release API exists. */
export class FinanceRunStore {
	private readonly storage: RunStorage;
	private readonly policy: RunPolicy;
	constructor(storage: RunStorage, policy: RunPolicy) {
		if (!validId(policy.domainId)) throw new Error('Invalid configured run domain');
		this.storage = storage;
		this.policy = policy;
	}
	private id(): string {
		const value = (this.policy.newId ?? (() => crypto.randomUUID()))();
		if (!validId(value)) throw new Error('Invalid generated run identity');
		return value;
	}
	async launch(principalId: string, input: unknown): Promise<LaunchReceipt | WireError> {
		if (!validId(principalId)) return failure('unauthenticated');
		let request;
		try {
			request = parseLaunchRequest(input);
		} catch {
			return failure('invalid_request');
		}
		const digest = await launchRequestDigest(request);
		const canonical = JSON.parse(canonicalLaunchRequest(request)) as {
			account_ids: string[];
			tracking_task_ids: string[];
		};
		return this.storage.transaction((sql) => {
			const prior = sql.get<ReceiptRow>(
				'SELECT * FROM finance_launch_receipts WHERE principal_id=? AND request_id=?',
				principalId,
				request.request_id
			);
			if (prior)
				return prior.request_digest === digest
					? (JSON.parse(prior.receipt_json) as LaunchReceipt)
					: failure('idempotency_conflict');
			if (
				sql.get(
					"SELECT run_id FROM finance_runs WHERE domain_id=? AND reservation='held'",
					this.policy.domainId
				)
			)
				return failure('domain_busy');
			if (!this.policy.resolveScope) return failure('unsupported');
			const resolved = this.policy.resolveScope(principalId, canonical.account_ids);
			if (!resolved || resolved.length !== canonical.account_ids.length)
				return failure('forbidden');
			const byId = new Map(resolved.map((account) => [account.account_id, account]));
			if (byId.size !== resolved.length || resolved.some((account) => !validId(account.source_id)))
				return failure('forbidden');
			const scope = canonical.account_ids.map((account_id) => ({
				account_id,
				source_id: byId.get(account_id)?.source_id
			}));
			if (scope.some((account) => !account.source_id)) return failure('forbidden');
			const runId = this.id();
			const receipt: LaunchReceipt = { run_id: runId, revision: 1 };
			sql.run(
				`INSERT INTO finance_runs (run_id,principal_id,domain_id,scope_json,task_ids_json,revision,transport,collection,cancellation,reservation,capture_closed)
    VALUES (?,?,?,?,?,1,'queued','not_started','none','held',0)`,
				runId,
				principalId,
				this.policy.domainId,
				JSON.stringify(scope),
				JSON.stringify(canonical.tracking_task_ids)
			);
			sql.run(
				'INSERT INTO finance_launch_receipts VALUES (?,?,?,?,?)',
				principalId,
				request.request_id,
				digest,
				JSON.stringify(receipt),
				runId
			);
			return receipt;
		});
	}
	async claim(authenticatedHostId: string, input: unknown): Promise<ClaimResponse | WireError> {
		if (!validId(authenticatedHostId)) return failure('unauthenticated');
		let request;
		try {
			request = parseClaimRequest(input);
		} catch {
			return failure('invalid_request');
		}
		const digest = await decisionRequestDigest(request);
		return this.storage.transaction((sql) => {
			const host = this.policy.resolveHost?.(authenticatedHostId);
			if (
				!host ||
				host.enabled !== true ||
				!validId(host.principal_id) ||
				host.domain_id !== this.policy.domainId
			)
				return failure('forbidden');
			const prior = sql.get<ReceiptRow>(
				'SELECT * FROM finance_claim_receipts WHERE host_id=? AND request_id=?',
				authenticatedHostId,
				request.request_id
			);
			if (prior) {
				if (prior.principal_id !== host.principal_id || prior.domain_id !== host.domain_id)
					return failure('forbidden');
				return prior.request_digest === digest
					? (JSON.parse(prior.receipt_json) as ClaimResponse)
					: failure('idempotency_conflict');
			}
			const queued = sql.get<RunRow>(
				`SELECT * FROM finance_runs WHERE principal_id=? AND domain_id=? AND reservation='held' AND cancellation='none' AND capture_closed=0 AND host_id IS NULL`,
				host.principal_id,
				host.domain_id
			);
			let receipt: ClaimResponse = { claim: null };
			if (queued) {
				const generation = this.id(),
					intent = this.id();
				updated(
					sql.run(
						`UPDATE finance_runs SET host_id=?,lease_generation=?,host_intent_id=?,transport='claimed',revision=revision+1 WHERE run_id=? AND revision=? AND host_id IS NULL AND cancellation='none' AND capture_closed=0`,
						authenticatedHostId,
						generation,
						intent,
						queued.run_id,
						queued.revision
					).changes
				);
				receipt = {
					claim: claimView({
						...queued,
						host_id: authenticatedHostId,
						lease_generation: generation,
						host_intent_id: intent,
						transport: 'claimed',
						revision: queued.revision + 1
					})
				};
			}
			sql.run(
				'INSERT INTO finance_claim_receipts VALUES (?,?,?,?,?,?)',
				authenticatedHostId,
				request.request_id,
				host.principal_id,
				host.domain_id,
				digest,
				JSON.stringify(receipt)
			);
			return receipt;
		});
	}
	read(principalId: string, runId: string): StoredRun | WireError {
		if (!validId(principalId)) return failure('unauthenticated');
		if (!validId(runId)) return failure('invalid_request');
		return this.storage.transaction((sql) => {
			const row = sql.get<RunRow>(
				'SELECT * FROM finance_runs WHERE run_id=? AND principal_id=?',
				runId,
				principalId
			);
			return row ? view(row) : failure('not_found');
		});
	}
	cancel(principalId: string, runId: string): CancelResponse | WireError {
		if (!validId(principalId)) return failure('unauthenticated');
		if (!validId(runId)) return failure('invalid_request');
		return this.storage.transaction((sql) => {
			const row = sql.get<RunRow>(
				'SELECT * FROM finance_runs WHERE run_id=? AND principal_id=?',
				runId,
				principalId
			);
			if (!row) return failure('not_found');
			const unclaimed = row.host_id === null && row.host_intent_id === null;
			if (row.cancellation === 'none') {
				updated(
					sql.run(
						`UPDATE finance_runs SET cancellation=?,collection=?,capture_closed=?,reservation=?,revision=revision+1 WHERE run_id=? AND revision=?`,
						unclaimed ? 'acknowledged' : 'requested',
						unclaimed ? 'cancelled' : 'not_started',
						unclaimed ? 1 : 0,
						unclaimed ? 'released' : 'held',
						runId,
						row.revision
					).changes
				);
				row.revision++;
				row.cancellation = unclaimed ? 'acknowledged' : 'requested';
				row.capture_closed = unclaimed ? 1 : 0;
			}
			return {
				run_id: runId,
				revision: row.revision,
				cancellation: row.cancellation as CancelResponse['cancellation'],
				capture_closed: row.capture_closed === 1,
				acknowledgment_kind: row.cancellation === 'acknowledged' ? 'server_unclaimed' : null
			};
		});
	}
}
