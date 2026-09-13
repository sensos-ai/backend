CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`role` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_sequence_unique` ON `messages` (`sequence`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_id` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_idempotency_id_unique` ON `runs` (`idempotency_id`);--> statement-breakpoint
CREATE INDEX `runs_created_at_idx` ON `runs` (`created_at`);