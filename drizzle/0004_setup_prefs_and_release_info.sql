ALTER TABLE `wizard_prefs` ADD COLUMN `setup_completed` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `wizard_prefs` ADD COLUMN `delivery_pref` text DEFAULT 'save' NOT NULL;
--> statement-breakpoint
CREATE TABLE `release_info` (
	`id` integer PRIMARY KEY NOT NULL,
	`latest_version` text NOT NULL,
	`release_kind` text NOT NULL,
	`release_note` text
);
