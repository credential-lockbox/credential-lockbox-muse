ALTER TABLE `wizard_prefs` ADD COLUMN `confirmation_pending` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `wizard_prefs` ADD COLUMN `completed_setup_version` text;
--> statement-breakpoint
ALTER TABLE `release_info` ADD COLUMN `setup_version` text DEFAULT '2' NOT NULL;
--> statement-breakpoint
CREATE TABLE `delivery_slot` (
	`id` integer PRIMARY KEY NOT NULL,
	`recipient` text,
	`service_label` text,
	`written_at` integer
);
--> statement-breakpoint
UPDATE `release_info` SET `latest_version` = 'proto-wizard-1.2', `setup_version` = '2', `release_note` = NULL WHERE `id` = 1;
