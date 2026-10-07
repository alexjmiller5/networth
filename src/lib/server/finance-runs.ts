/** Durable request/reservation slice. No route or native operation is enabled.
 * Callers must authenticate principals/hosts and resolve the configured physical
 * domain before using this repository. A run snapshot never grants collection.
 */
import {
	canonicalLaunchRequest,
	launchRequestDigest,
	parseLaunchRequest,
	type LaunchRequest,
	type RunControl,
	type CancelResponse
} from '$lib/finance/run-contract';

export class RunStoreError extends Error {
	constructor(
		public readonly code: 'invalid_request' | 'idempotency_conflict' | 'domain_busy' | 'not_found'
	) {
		super(code);
	}
}
interface StoredRun {
	snapshot: string;
	request_digest: string;
}
const unavailable = () => ({ state: 'unavailable' as const, reason: 'Not verified' });

export class FinanceRuns {
	constructor(private readonly db: D1Database) {}
	private async existing(principal: string, requestId: string): Promise<StoredRun | null> {
		return this.db
			.prepare(
				'SELECT snapshot, request_digest FROM finance_runs WHERE principal=? AND request_id=?'
			)
			.bind(principal, requestId)
			.first<StoredRun>();
	}
	private replay(row: StoredRun, digest: string): RunControl {
		if (row.request_digest !== digest) throw new RunStoreError('idempotency_conflict');
		return JSON.parse(row.snapshot);
	}
	async launch(
		principal: string,
		domainId: string,
		input: unknown,
		eligible: (request: LaunchRequest) => Promise<boolean>
	): Promise<RunControl> {
		const request = parseLaunchRequest(input);
		Object.freeze(request.account_ids);
		Object.freeze(request.tracking_task_ids);
		Object.freeze(request);
		const digest = await launchRequestDigest(request);
		const existing = await this.existing(principal, request.request_id);
		if (existing) return this.replay(existing, digest);
		if (!principal || !domainId || !(await eligible(request)))
			throw new RunStoreError('invalid_request');
		const canonical = JSON.parse(canonicalLaunchRequest(request));
		const snapshot: RunControl = {
			run_id: crypto.randomUUID(),
			host_id: '',
			lease_generation: '',
			revision: 0,
			account_ids: canonical.account_ids,
			tracking_task_ids: canonical.tracking_task_ids,
			domain_id: domainId,
			cancellation: 'none',
			capture_closed: false,
			transport: 'queued',
			collection: 'not_started',
			review: 'not_started',
			reservation: 'held',
			eligibility: { state: 'unknown', checked_at: null },
			readiness: {
				native_identity: unavailable(),
				user_reachability: unavailable(),
				collector_context: unavailable(),
				source_controls: unavailable()
			},
			start_instruction_id: null,
			next_sequence: 1
		};
		try {
			await this.db
				.prepare(
					'INSERT INTO finance_runs(run_id,principal,request_id,request_digest,domain_id,snapshot) VALUES(?,?,?,?,?,?)'
				)
				.bind(
					snapshot.run_id,
					principal,
					request.request_id,
					digest,
					domainId,
					JSON.stringify(snapshot)
				)
				.run();
		} catch (error) {
			// Resolve committed retries before mutable/domain checks, including races.
			const committed = await this.existing(principal, request.request_id);
			if (committed) return this.replay(committed, digest);
			const busy = await this.db
				.prepare(
					"SELECT 1 FROM finance_runs WHERE domain_id=? AND json_extract(snapshot,'$.reservation')='held'"
				)
				.bind(domainId)
				.first();
			if (busy) throw new RunStoreError('domain_busy');
			throw error;
		}
		return snapshot;
	}
	async read(principal: string, runId: string): Promise<RunControl | null> {
		const row = await this.db
			.prepare('SELECT snapshot FROM finance_runs WHERE principal=? AND run_id=?')
			.bind(principal, runId)
			.first<{ snapshot: string }>();
		return row ? JSON.parse(row.snapshot) : null;
	}
	async cancel(principal: string, runId: string): Promise<CancelResponse> {
		// One SQL statement is serialized against claim. No read-then-write gap.
		const row = await this.db
			.prepare(
				`UPDATE finance_runs SET snapshot=json_set(snapshot,
			'$.revision',json_extract(snapshot,'$.revision')+1,
			'$.cancellation',CASE WHEN host_operation_intent=0 THEN 'acknowledged' ELSE 'requested' END,
			'$.collection',CASE WHEN host_operation_intent=0 THEN 'cancelled' ELSE json_extract(snapshot,'$.collection') END,
			'$.capture_closed',json(CASE WHEN host_operation_intent=0 OR json_extract(snapshot,'$.capture_closed')=1 THEN 'true' ELSE 'false' END),
			'$.reservation',CASE WHEN host_operation_intent=0 THEN 'released' ELSE json_extract(snapshot,'$.reservation') END)
			WHERE principal=? AND run_id=? AND json_extract(snapshot,'$.cancellation')='none'
			RETURNING snapshot`
			)
			.bind(principal, runId)
			.first<{ snapshot: string }>();
		const control: RunControl | null = row
			? JSON.parse(row.snapshot)
			: await this.read(principal, runId);
		if (!control) throw new RunStoreError('not_found');
		if (control.cancellation === 'none') throw new Error('Cancellation did not commit');
		return {
			run_id: runId,
			revision: control.revision,
			cancellation: control.cancellation,
			acknowledgment_kind: control.cancellation === 'acknowledged' ? 'server_unclaimed' : null,
			capture_closed: control.capture_closed
		};
	}
	/** Internal conditional reservation claim only. Authentication, host enrollment,
	 * claim-request retry receipts and queued eligibility recheck are not implemented.
	 * Do not expose this seam as the canonical claims route. */
	async claim(
		hostId: string,
		runId: string,
		expectedRevision: number,
		generation: string
	): Promise<RunControl | null> {
		if (!hostId || !generation || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new RunStoreError('invalid_request');
		const row = await this.db
			.prepare(
				`UPDATE finance_runs SET host_operation_intent=1,
			snapshot=json_set(snapshot,'$.host_id',?,'$.lease_generation',?,'$.transport','claimed','$.revision',?+1)
			WHERE run_id=? AND host_operation_intent=0 AND json_extract(snapshot,'$.revision')=?
			AND json_extract(snapshot,'$.transport')='queued' AND json_extract(snapshot,'$.reservation')='held'
			AND json_extract(snapshot,'$.cancellation')='none' AND json_extract(snapshot,'$.capture_closed')=0
			RETURNING snapshot`
			)
			.bind(hostId, generation, expectedRevision, runId, expectedRevision)
			.first<{ snapshot: string }>();
		return row ? JSON.parse(row.snapshot) : null;
	}
}
