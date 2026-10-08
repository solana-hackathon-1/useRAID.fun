-- Host-owned account table. The link module requires a text "id" key and a boolean "suspended".
CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "handle" TEXT NOT NULL, "suspended" BOOLEAN NOT NULL DEFAULT false);
