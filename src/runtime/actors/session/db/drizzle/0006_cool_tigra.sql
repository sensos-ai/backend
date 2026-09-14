ALTER TABLE `runs` ADD `model_provider` text DEFAULT 'gateway' NOT NULL;
--> statement-breakpoint
UPDATE `runs` SET `model_provider` = 'codex' WHERE instr(`model`, '/') = 0;
