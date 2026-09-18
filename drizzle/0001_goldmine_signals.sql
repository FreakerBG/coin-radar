CREATE TABLE `goldmine_outcomes` (
	`signal_id` text NOT NULL,
	`horizon` text NOT NULL,
	`due_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`observed_at` integer,
	`price` real,
	`liquidity` real,
	PRIMARY KEY(`signal_id`, `horizon`)
);
--> statement-breakpoint
CREATE INDEX `goldmine_outcomes_status_due_idx` ON `goldmine_outcomes` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `goldmine_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`pair` text NOT NULL,
	`symbol` text NOT NULL,
	`model_version` text NOT NULL,
	`state` text NOT NULL,
	`score` integer NOT NULL,
	`opportunity` integer NOT NULL,
	`detected_at` integer NOT NULL,
	`detected_price` real NOT NULL,
	`snapshot` text NOT NULL,
	`assessment` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goldmine_signals_detected_at_idx` ON `goldmine_signals` (`detected_at`);--> statement-breakpoint
CREATE INDEX `goldmine_signals_pair_idx` ON `goldmine_signals` (`pair`,`address`);