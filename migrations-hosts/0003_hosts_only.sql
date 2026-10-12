-- Only finance hosts enroll now: phone rows go, every remaining row is a host.
DELETE FROM widget_devices WHERE kind <> 'host';
ALTER TABLE widget_devices DROP COLUMN kind;
ALTER TABLE widget_devices RENAME TO hosts;
