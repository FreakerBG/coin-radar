CREATE TABLE `goldmine_alert_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`signal_id` text NOT NULL,
	`model_version` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires` integer,
	`delivered_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `goldmine_alert_outbox_address_created_idx` ON `goldmine_alert_outbox` (`address`,`created_at`);--> statement-breakpoint
CREATE INDEX `goldmine_alert_outbox_status_next_idx` ON `goldmine_alert_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `goldmine_alert_state` (
	`address` text PRIMARY KEY NOT NULL,
	`last_qualifying_at` integer,
	`last_genuine_nonqualifying_at` integer,
	`updated_at` integer NOT NULL
);
