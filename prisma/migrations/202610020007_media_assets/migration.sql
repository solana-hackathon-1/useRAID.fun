CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "uploaderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MediaAsset_mime_check" CHECK ("mime" IN ('image/png', 'image/jpeg', 'image/gif')),
    CONSTRAINT "MediaAsset_size_check" CHECK ("size" > 0 AND "size" <= 256000)
);

CREATE UNIQUE INDEX "MediaAsset_sha256_key" ON "MediaAsset"("sha256");

ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
