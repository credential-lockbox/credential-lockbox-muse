ALTER TABLE `wizard_prefs` ADD COLUMN `pending_recipient_hash` text;
--> statement-breakpoint
ALTER TABLE `wizard_prefs` DROP COLUMN `skip_key_check`;
--> statement-breakpoint
ALTER TABLE `delivery_slot` ADD COLUMN `reason` text;
--> statement-breakpoint
ALTER TABLE `persisted_recipient` ADD COLUMN `reason` text;
--> statement-breakpoint
UPDATE `release_info` SET `latest_version` = 'proto-wizard-1.9', `release_kind` = 'update', `release_note` = NULL WHERE `id` = 1;
