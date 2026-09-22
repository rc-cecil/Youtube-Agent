ALTER TABLE "UploadSession" ADD COLUMN "contentType" TEXT NOT NULL DEFAULT 'AUTO';
ALTER TABLE "SourceVideo" ADD COLUMN "contentType" TEXT NOT NULL DEFAULT 'AUTO';
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_contentType_check" CHECK ("contentType" IN ('AUTO', 'GAMEPLAY', 'PODCAST'));
ALTER TABLE "SourceVideo" ADD CONSTRAINT "SourceVideo_contentType_check" CHECK ("contentType" IN ('AUTO', 'GAMEPLAY', 'PODCAST'));
