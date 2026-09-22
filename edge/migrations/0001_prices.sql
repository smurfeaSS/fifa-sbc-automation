CREATE TABLE `prices` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text,
	`name` text,
	`rating` integer NOT NULL,
	`quality` text DEFAULT 'gold' NOT NULL,
	`rarity` text DEFAULT 'rare' NOT NULL,
	`position` text,
	`nation_id` integer,
	`nation_name` text,
	`league_id` integer,
	`league_name` text,
	`club_id` integer,
	`club_name` text,
	`price_coins` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `prices_lookup_idx` ON `prices` (`rating`,`price_coins`);--> statement-breakpoint
CREATE INDEX `prices_asset_idx` ON `prices` (`asset_id`);