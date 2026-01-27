CREATE TABLE `analyzed_comments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`replyId` varchar(64) NOT NULL,
	`sentiment` enum('positive','neutral','negative','anger','sarcasm') NOT NULL,
	`valueScore` decimal(3,2) NOT NULL,
	`valueType` json NOT NULL,
	`summary` text NOT NULL,
	`analyzedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `analyzed_comments_id` PRIMARY KEY(`id`),
	CONSTRAINT `analyzed_comments_replyId_unique` UNIQUE(`replyId`)
);
--> statement-breakpoint
CREATE TABLE `monitor_targets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`type` enum('account','tweet') NOT NULL,
	`targetId` varchar(64) NOT NULL,
	`targetName` varchar(255),
	`targetHandle` varchar(64),
	`isActive` int NOT NULL DEFAULT 1,
	`lastFetchedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `monitor_targets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `raw_comments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`replyId` varchar(64) NOT NULL,
	`tweetId` varchar(64) NOT NULL,
	`authorId` varchar(64) NOT NULL,
	`authorName` varchar(255) NOT NULL,
	`authorHandle` varchar(64) NOT NULL,
	`text` text NOT NULL,
	`createdAt` timestamp NOT NULL,
	`likeCount` int NOT NULL DEFAULT 0,
	`replyTo` varchar(64),
	`fetchedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `raw_comments_id` PRIMARY KEY(`id`),
	CONSTRAINT `raw_comments_replyId_unique` UNIQUE(`replyId`)
);
--> statement-breakpoint
CREATE TABLE `system_config` (
	`id` int AUTO_INCREMENT NOT NULL,
	`configKey` varchar(64) NOT NULL,
	`configValue` text,
	`description` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `system_config_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_config_configKey_unique` UNIQUE(`configKey`)
);
