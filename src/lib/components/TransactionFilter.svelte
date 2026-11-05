<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import IconFilter from '@tabler/icons-svelte/icons/filter';
	import {
		TRANSACTION_FIELDS,
		FILTER_OPERATORS,
		type TransactionFilter
	} from '$lib/finance/transactionFilter';
	let {
		filter = $bindable(),
		disabled = false
	}: { filter: TransactionFilter; disabled?: boolean } = $props();
	const active = $derived(
		filter.operator === 'missing' || filter.operator === 'present' || !!filter.value.trim()
	);
	const numeric = $derived(['amount', 'qty', 'pps', 'rewards', 'points'].includes(filter.field));
	const invalid = $derived(
		numeric &&
			['min', 'max', 'equals'].includes(filter.operator) &&
			!!filter.value.trim() &&
			!Number.isFinite(Number(filter.value))
	);
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				{disabled}
				variant={active && !disabled ? 'default' : 'outline'}
				size="sm"
				aria-label="Transaction filter"
			>
				<IconFilter size={16} />{active && !disabled ? 'Transactions filtered' : 'Transactions'}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 max-w-[calc(100vw-1rem)] space-y-3" align="end">
		<p class="text-sm font-medium">Filter spending and income</p>
		<Select.Root
			type="single"
			value={filter.field}
			onValueChange={(field) => {
				filter = {
					...filter,
					field: field as TransactionFilter['field'],
					operator: ['amount', 'qty', 'pps', 'rewards', 'points'].includes(field)
						? 'equals'
						: 'contains'
				};
			}}
		>
			<Select.Trigger aria-label="Transaction field"
				>{TRANSACTION_FIELDS[filter.field]}</Select.Trigger
			>
			<Select.Content>
				{#each Object.entries(TRANSACTION_FIELDS) as [field, label] (field)}
					<Select.Item value={field} {label} />
				{/each}
			</Select.Content>
		</Select.Root>
		<Select.Root
			type="single"
			value={filter.operator}
			onValueChange={(operator) => {
				filter = { ...filter, operator: operator as TransactionFilter['operator'] };
			}}
		>
			<Select.Trigger aria-label="Filter comparison"
				>{FILTER_OPERATORS[filter.operator]}</Select.Trigger
			>
			<Select.Content>
				{#each Object.entries(FILTER_OPERATORS) as [operator, label] (operator)}
					{#if numeric || !['min', 'max'].includes(operator)}<Select.Item
							value={operator}
							{label}
						/>{/if}
				{/each}
			</Select.Content>
		</Select.Root>
		{#if !['missing', 'present'].includes(filter.operator)}
			<Input
				aria-label="Transaction filter value"
				bind:value={filter.value}
				placeholder="Filter value"
				aria-invalid={invalid}
			/>
		{/if}
		{#if invalid}<p class="text-xs text-destructive" role="status">Enter a valid number.</p>{/if}
		<p class="text-xs text-muted-foreground">
			Applies to owned flow entries after splits. Amounts keep their signs; refunds still reduce
			spending. Balances use the full ledger. A missing review timestamp does not mean
			uncategorized.
		</p>
		<Button
			variant="ghost"
			size="sm"
			onclick={() => {
				filter = { field: 'name', operator: 'contains', value: '' };
			}}>Clear filter</Button
		>
	</Popover.Content>
</Popover.Root>
