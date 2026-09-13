ALTER TABLE `runs` ADD `requested_model` text DEFAULT 'openai/gpt-5.6-terra' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `resolved_model` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `steps` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `total_usage` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `response_metadata` text;