CREATE TABLE `pageViews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`visitedAt` timestamp NOT NULL DEFAULT (now()),
	`ipAddress` varchar(45) NOT NULL,
	`referrer` text,
	`userAgent` text,
	`deviceType` enum('desktop','tablet','mobile') NOT NULL,
	`enteredToken` int NOT NULL DEFAULT 0,
	`tokenEntered` varchar(4),
	`wasConnectedTo` int NOT NULL DEFAULT 0,
	`hostToken` varchar(4),
	`hadFileTransfer` int NOT NULL DEFAULT 0,
	`bytesTransferred` int NOT NULL DEFAULT 0,
	`sessionDurationSeconds` int NOT NULL DEFAULT 0,
	`sessionId` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pageViews_id` PRIMARY KEY(`id`)
);
