CREATE TABLE `Session` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'INIT' NOT NULL,
	`retries` integer DEFAULT 0 NOT NULL,
	`error` text,
	`failureDetails` text,
	`createdAt` integer,
	`updatedAt` integer,
	`clarification` text,
	`plan` text,
	`code` text,
	`review` text,
	`reviewCount` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `User` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`email` text NOT NULL,
	`emailVerified` integer,
	`image` text,
	`createdAt` integer,
	`credits` integer DEFAULT 5 NOT NULL,
	`lastCreditResetAt` integer,
	`tier` text DEFAULT 'FREE' NOT NULL,
	`country` text,
	`city` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `User_email_unique` ON `User` (`email`);