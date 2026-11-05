-- Tables this host owns and supplies to the Party storage. A RAID Root host has the full identity schema instead; this
-- minimal host declares its smaller layout (no X key, no wallet links) through `identityLayout` in host.ts.
CREATE TABLE "User" ("id" text PRIMARY KEY, "suspended" boolean NOT NULL DEFAULT false);
CREATE TABLE "Session" ("tokenHash" text PRIMARY KEY, "userId" text NOT NULL REFERENCES "User", "via" text NOT NULL, "expiresAt" timestamp(3) NOT NULL);
CREATE TABLE "Participant" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "accountId" text NOT NULL UNIQUE REFERENCES "User" ON DELETE RESTRICT ON UPDATE RESTRICT, "kind" text NOT NULL DEFAULT 'HUMAN' CHECK ("kind" IN ('HUMAN','AI_AGENT')));
CREATE TABLE "WalletIdentity" ("address" text PRIMARY KEY, "userId" text NOT NULL REFERENCES "User");
CREATE TABLE "WalletLink" ("id" uuid PRIMARY KEY, "address" text NOT NULL, "accountId" text NOT NULL REFERENCES "User");
-- Host-owned authority and funding records behind the work-loop `WorkHost` port that publishes the fixture slot.
CREATE TABLE "HostGuildAuthority" ("guildId" text PRIMARY KEY, "accountId" text NOT NULL REFERENCES "User");
CREATE TABLE "HostReservation" ("slotId" uuid PRIMARY KEY, "termsVersionId" uuid NOT NULL, "digest" text NOT NULL);
