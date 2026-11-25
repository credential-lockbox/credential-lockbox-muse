CREATE TABLE `persisted_recipient` (
	`id` integer PRIMARY KEY NOT NULL,
	`recipient` text,
	`written_at` integer
);
--> statement-breakpoint
ALTER TABLE `saved_blobs` ADD COLUMN `recipient_hash` text;
--> statement-breakpoint
UPDATE `release_info` SET `latest_version` = 'proto-wizard-1.6', `release_note` = NULL WHERE `id` = 1;
