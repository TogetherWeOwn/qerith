-- Folder rank and name direction are independent; IDs always break ties ascending.
CREATE INDEX drive_entries_listing_asc
  ON drive_entries(owner_id, parent_id, kind DESC, name COLLATE BINARY ASC, id ASC);
CREATE INDEX drive_entries_listing_desc
  ON drive_entries(owner_id, parent_id, kind DESC, name COLLATE BINARY DESC, id ASC);
