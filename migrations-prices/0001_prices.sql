-- Networth's own daily price cache. Owner-entered price sources say which provider
-- series values each ledger security; closes are raw provider facts, never adjusted.

-- account_id + security_id are the ledger's exact identity (Soma accounts.id and the
-- txns ticker / native security id). netbenefits reads NAV observations from Soma.
CREATE TABLE price_mappings (
	account_id TEXT NOT NULL,
	security_id TEXT NOT NULL,
	provider TEXT NOT NULL CHECK (provider IN ('tiingo', 'fidelity', 'alphavantage', 'netbenefits')),
	symbol TEXT CHECK ((provider = 'netbenefits') = (symbol IS NULL)),
	currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
	revision INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (account_id, security_id)
);

-- One raw close (or NAV) per provider series and trading date. A missing date is a
-- gap; nothing is interpolated or stored as zero.
CREATE TABLE price_closes (
	provider TEXT NOT NULL CHECK (provider IN ('tiingo', 'fidelity', 'alphavantage')),
	symbol TEXT NOT NULL,
	date TEXT NOT NULL,
	close TEXT NOT NULL,
	currency TEXT NOT NULL,
	basis TEXT NOT NULL CHECK (basis IN ('raw-close', 'raw-nav')),
	split_factor TEXT,
	fetched_at TEXT NOT NULL,
	PRIMARY KEY (provider, symbol, date)
) WITHOUT ROWID;
