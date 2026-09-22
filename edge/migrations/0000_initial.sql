CREATE TABLE `club_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`exported_at` text NOT NULL,
	`game_version` text NOT NULL,
	`player_count` integer DEFAULT 0 NOT NULL,
	`import_in_progress` integer DEFAULT false NOT NULL,
	`import_token` text
);
--> statement-breakpoint
CREATE TABLE `history` (
	`id` text PRIMARY KEY NOT NULL,
	`sbc_name` text NOT NULL,
	`challenge_name` text NOT NULL,
	`date` text NOT NULL,
	`players_submitted` integer DEFAULT 0 NOT NULL,
	`player_ids` text DEFAULT '[]' NOT NULL,
	`estimated_value` integer DEFAULT 0 NOT NULL,
	`tradeable_value` integer DEFAULT 0 NOT NULL,
	`untradeable_value` integer DEFAULT 0 NOT NULL,
	`duplicates_used` integer DEFAULT 0 NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `history_date_idx` ON `history` (`date`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`resource_id` text,
	`name` text NOT NULL,
	`rating` integer NOT NULL,
	`position` text NOT NULL,
	`position_group` text NOT NULL,
	`alternate_positions` text DEFAULT '[]' NOT NULL,
	`nation_id` integer DEFAULT 0 NOT NULL,
	`nation_name` text,
	`league_id` integer DEFAULT 0 NOT NULL,
	`league_name` text,
	`club_id` integer DEFAULT 0 NOT NULL,
	`club_name` text,
	`card_type` text NOT NULL,
	`raw_rarity_id` integer,
	`tradeability` text NOT NULL,
	`untradeable_until` text,
	`is_duplicate` integer DEFAULT false NOT NULL,
	`duplicate_count` integer DEFAULT 1 NOT NULL,
	`is_evolved` integer DEFAULT false NOT NULL,
	`evolution_path_id` text,
	`is_first_owner` integer DEFAULT false NOT NULL,
	`in_active_squad` integer DEFAULT false NOT NULL,
	`squad_usage` text DEFAULT '[]' NOT NULL,
	`contracts` integer,
	`value_coins` integer DEFAULT 0 NOT NULL,
	`value_source` text DEFAULT 'heuristic' NOT NULL,
	`value_confidence` real DEFAULT 0.3 NOT NULL,
	`manually_locked` integer DEFAULT false NOT NULL,
	`is_favourite` integer DEFAULT false NOT NULL,
	`note` text,
	`is_protected` integer DEFAULT false NOT NULL,
	`protection_reasons` text DEFAULT '[]' NOT NULL,
	`sacrifice_cost` real DEFAULT 0 NOT NULL,
	`priority_tier` integer DEFAULT 6 NOT NULL,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `players_pool_idx` ON `players` (`is_protected`,`rating`,`sacrifice_cost`);--> statement-breakpoint
CREATE INDEX `players_asset_idx` ON `players` (`asset_id`);--> statement-breakpoint
CREATE INDEX `players_rating_idx` ON `players` (`rating`);--> statement-breakpoint
CREATE INDEX `players_name_idx` ON `players` (`name`);--> statement-breakpoint
CREATE TABLE `sbcs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`json` text NOT NULL,
	`source_kind` text DEFAULT 'manual' NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `squads` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`formation` text,
	`player_ids` text DEFAULT '[]' NOT NULL,
	`is_active` integer DEFAULT false NOT NULL
);
