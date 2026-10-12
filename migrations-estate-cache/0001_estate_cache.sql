-- Networth's incremental copy of the Soma tables it reads (soma's table-pull helper).
-- Disposable: emptying pull_state makes the next load pull every table in full.
-- `tbl` is a hub table name or a slice name; a slice's `since`/`n` hold the mark
-- and row count of its watched table, `columns` its definition.
CREATE TABLE pull_state (
	tbl TEXT PRIMARY KEY,
	endpoint TEXT NOT NULL,
	columns TEXT NOT NULL,
	since TEXT NOT NULL,
	n INTEGER NOT NULL
);
-- One pulled row (JSON, tombstones included) per table and id.
CREATE TABLE pull_rows (
	tbl TEXT NOT NULL,
	id TEXT NOT NULL,
	row TEXT NOT NULL,
	PRIMARY KEY (tbl, id)
) WITHOUT ROWID;
