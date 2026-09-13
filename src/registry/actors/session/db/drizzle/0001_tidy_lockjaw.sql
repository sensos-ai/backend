CREATE TABLE `run_frames` (
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `sequence`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_frames_run_id_sequence_idx` ON `run_frames` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `session_meta` (
	`singleton_id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`active_run_id` text
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `user_message_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `assistant_message_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `finish_reason` text;
