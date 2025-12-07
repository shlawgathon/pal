import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Cloudflare R2 endpoint (if using R2) or undefined for standard AWS S3
const R2_ENDPOINT = 'https://9863c39a384de0942d9656f9241489dc.r2.cloudflarestorage.com';
const R2_PUBLIC_URL = 'https://pal.images.growly.gg';

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'auto', // R2 uses 'auto' for region
    endpoint: R2_ENDPOINT, // e.g., https://<account_id>.r2.cloudflarestorage.com
    credentials: {
        accessKeyId: require('dotenv').config()['AWS_SECRET_ACCESS_ID'],
        secretAccessKey: require('dotenv').config()['AWS_SECRET_ACCESS_KEY'],
    },
    // R2 requires this to be set for S3 compatibility
    ...(R2_ENDPOINT && { forcePathStyle: true }),
});

const BUCKET_NAME = 'pal';

/**
 * Generate the public URL for an object
 * Uses R2 public URL if configured, otherwise falls back to S3 URL format
 */
function getPublicUrl(key: string): string {
    if (R2_PUBLIC_URL) {
        // R2 custom domain or public bucket URL
        return `${R2_PUBLIC_URL}/${key}`;
    }
    // Standard S3 URL format
    return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
}

/**
 * Upload a file to S3/R2
 */
export async function uploadToS3(
    key: string,
    body: Buffer,
    contentType: string
): Promise<{ s3Key: string; s3Url: string }> {
    await s3Client.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
    }));

    const s3Url = getPublicUrl(key);

    return { s3Key: key, s3Url };
}

/**
 * Get a signed URL for temporary access to a private object
 */
export async function getSignedS3Url(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
    });

    return getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Download a file from S3
 */
export async function downloadFromS3(key: string): Promise<Buffer> {
    const response = await s3Client.send(new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
    }));

    const chunks: Buffer[] = [];
    const stream = response.Body as NodeJS.ReadableStream;

    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
}

/**
 * Delete a file from S3
 */
export async function deleteFromS3(key: string): Promise<void> {
    await s3Client.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
    }));
}

/**
 * Generate S3 key for job files
 */
export function generateS3Key(jobId: string, filename: string, type: 'original' | 'enhanced' = 'original'): string {
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    return `jobs/${jobId}/${type}/${sanitizedFilename}`;
}

export { s3Client, BUCKET_NAME };
