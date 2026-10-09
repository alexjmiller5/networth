# Native investment observations

The Investments page reads the cataloged `investment_instruments` and
`investment_observations` tables through the existing dedicated Soma reader.
It shows native units, provider prices, reported market values and custody cash
independently. Missing data remains unavailable. The page does not infer holdings
completeness, compute a portfolio total, or reuse transaction prices as NAVs. The
dashboard's market valuation (`docs/price-history.md`) uses these observations only
to cross-check ledger units and, for NetBenefits plan funds, as dated NAVs. The
page also edits the price sources that valuation reads.

Decimal values remain strings all the way to rendering. Each selected source
assertion includes its source date or instant and separate capture time. Date-only,
timestamp and undated evidence have separate groups, as do different currencies
and source clocks. A later capture cannot resolve conflicting assertions about the
same source time. Expanded history retains the original observations.

Before selecting a value, the consumer validates the complete correction graph.
Duplicate IDs, missing predecessors, forks, cycles and edges across instrument,
metric or price kind make all affected groups unavailable. A multi-page read has
no consistent snapshot guarantee, so its observations remain visible without an
authoritative selection. Even a complete observation table is not evidence of a
complete account holdings snapshot.

The page shares the dashboard's device-local concealment preference and changes
only that preference. Concealment covers exact amounts, native units and free-text
missing reasons, including expanded history. It is visual concealment; the
underlying data remains on the device. Offline observations show their saved time.

Instrument identity hashes use the source contract's domain-separated JSON array,
ASCII Unicode escapes, UTF-8 bytes and SHA-256. The cross-language golden vector is
covered by the unit suite. Source identifiers are never normalized or joined by
display label.

This reader does not publish, correct or reclassify source observations. Those
operations use the data service's catalog, evidence and guarded-write contracts.
