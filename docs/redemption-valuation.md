# Redemption valuation calculations

`calculateRedemptionValuation` prepares an immutable calculation proposal from
an explicitly selected basis. It does not query data, choose between competing
rules, resolve history, approve an assertion, or publish a valuation. The caller
must resolve the current event head and evidence using its supported guarded
read/write contract before activation.

Inputs are canonical decimal strings: at most 100 digits total and 50 fractional
digits, no exponent, leading integer zeros, trailing fractional zeros, whitespace, plus sign, or negative
zero. Source lexemes belong in retained evidence. All arithmetic uses BigInt
scaled decimals. Exact results outside those bounds reject instead of rounding.
Only `rate_at_redemption` rounds to 18 fractional places, HALF_EVEN; canonical
output removes trailing zeros. `reward_value` and `units_consumed` retain the
exact rational numerator and denominator. `calculation_version` is fixed by this
implementation, never supplied by a caller.

A posted redemption must consume positive native units matching the negative
event delta. Component, role, native currency, event head and evidence scopes
must agree. Evidence binds the selected amount, currency, scope and estimate
version. The function checks supplied evidence consistency; a reference or
`chain_verified` flag is not independent proof of approval or a publication
permission. The service resolving those assertions owns authenticity and race
protection. Evidence references are not copied into the calculated result.

For a gross comparable value, the receipt must declare complete provider- or
user-attributed out-of-pocket coverage with retained evidence. Deductions must
match its whole canonical set of positive costs. Duplicate, missing, overlapping,
cyclic, foreign-currency or noncost legs reject. Explicit paid cash must be
represented by itself or a selected containing total. Tax, fee and tip roles
alone do not establish that the cost was paid out of pocket: the attributed
canonical set and its evidence establish that fact. A complete empty set can
represent evidenced zero cost; missing receipts or partial coverage cannot.
Reward-funded comparables require an empty deduction set and never subtract
cash again.

Owner overrides require owner-confirmed evidence. Provider comparables also
require an explicit documented amount/scope rule. Estimates require the exact
selected user-approved term version, matching program/component/currency/method,
an effective lower date and an optional exclusive upper date. An unknown event
or lower date cannot use capture time as a substitute. Free-text conditions are
not executable: nonempty estimate conditions remain unsupported. A supported
estimate freezes the exact approved rate times consumed units as its comparable
amount, using reward-funded scope. Supplying another term does not replace a
selected override or modify a frozen result.

The return value and deduction array are frozen. Persistent valuation IDs,
supersession chains, provenance, current-head selection, manual approval,
read-set validation, and guarded publication remain outside this module. No
runtime schema, endpoint, UI or active valuation is created by it.
