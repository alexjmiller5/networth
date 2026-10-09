-- Owner-entered dollars per native unit for a reward program. Dashboard state, not a
-- provider fact: it never enters Life Data and only labels estimates in the dollar lens.
CREATE TABLE reward_values (
 program_id TEXT PRIMARY KEY NOT NULL CHECK (length(program_id) BETWEEN 1 AND 200),
 value_per_unit TEXT NOT NULL CHECK (length(value_per_unit) BETWEEN 1 AND 40),
 revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
