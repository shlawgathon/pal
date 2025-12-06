import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET || 'pal-media-storage';

/**
 * Upload a file to S3
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

    const s3Url = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;

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
