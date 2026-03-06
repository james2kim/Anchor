import { Storage } from '@google-cloud/storage';

const BUCKET_NAME = process.env.GCS_UPLOAD_BUCKET || 'anchor-cd21e-uploads';

const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);

export interface SignedUploadUrlOptions {
  userId: string;
  fileId: string;
  filename: string;
  contentType: string;
}

export interface SignedUploadUrlResult {
  signedUrl: string;
  gcsPath: string;
}

/**
 * Generate a signed URL for uploading a file directly to GCS.
 */
export async function generateSignedUploadUrl({
  userId,
  fileId,
  filename,
  contentType,
}: SignedUploadUrlOptions): Promise<SignedUploadUrlResult> {
  const gcsPath = `uploads/${userId}/${fileId}/${filename}`;
  const file = bucket.file(gcsPath);

  const [signedUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + 30 * 60 * 1000, // 30 minutes
    contentType,
  });

  return { signedUrl, gcsPath };
}

/**
 * Download a file from GCS as a Buffer.
 */
export async function downloadAsBuffer(gcsPath: string): Promise<Buffer> {
  const file = bucket.file(gcsPath);
  const [contents] = await file.download();
  return contents;
}

/**
 * Delete a file from GCS.
 */
export async function deleteFile(gcsPath: string): Promise<void> {
  const file = bucket.file(gcsPath);
  await file.delete({ ignoreNotFound: true });
}

/**
 * Check if a file exists in GCS.
 */
export async function fileExists(gcsPath: string): Promise<boolean> {
  const file = bucket.file(gcsPath);
  const [exists] = await file.exists();
  return exists;
}
