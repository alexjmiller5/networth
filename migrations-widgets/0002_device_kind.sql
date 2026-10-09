-- Widgets read snapshots; hosts claim finance review runs. Neither reaches the other's routes.
ALTER TABLE widget_devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'widget' CHECK(kind IN ('widget','host'));
