/**
 * WebSocket upload handler for chunked file uploads
 */

import { createWriteStream, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';
import { v4 as uuidv4 } from 'uuid';
import prisma from './prisma';
import { uploadToS3, generateS3Key } from './s3';
import { processJob } from './processing/pipeline';
import {
    SUPPORTED_IMAGE_EXTENSIONS,
    SUPPORTED_VIDEO_EXTENSIONS,
    type JobStatus,
    type WSMessage,
    type WSStatusMessage,
} from './types';
import type { WebSocket } from 'ws';

interface UploadSession {
    jobId: string;
    tempPath: string;
    fileStream: ReturnType<typeof createWriteStream>;
    receivedChunks: number;
    totalChunks: number;
    totalSize: number;
}

const activeSessions = new Map<string, UploadSession>();

/**
 * Get MIME type from file extension
 */
function getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() || '';
    const mimeTypes: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        heic: 'image/heic',
        heif: 'image/heif',
        bmp: 'image/bmp',
        tiff: 'image/tiff',
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        avi: 'video/x-msvideo',
        mkv: 'video/x-matroska',
        webm: 'video/webm',
        m4v: 'video/x-m4v',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Check if file should be skipped (hidden files, macOS resource forks, etc.)
 */
function shouldSkipFile(filename: string): boolean {
    const basename = filename.split('/').pop() || filename;

    // Skip macOS resource fork files (._*)
    if (basename.startsWith('._')) return true;

    // Skip hidden files
    if (basename.startsWith('.')) return true;

    // Skip macOS __MACOSX directory contents
    if (filename.includes('__MACOSX')) return true;

    // Skip Thumbs.db (Windows)
    if (basename.toLowerCase() === 'thumbs.db') return true;

    return false;
}

/**
 * Determine if file is image or video
 */
function getMediaType(filename: string): 'image' | 'video' | null {
    // Skip system/hidden files
    if (shouldSkipFile(filename)) return null;

    const ext = '.' + (filename.toLowerCase().split('.').pop() || '');

    if (SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
        return 'image';
    }
    if (SUPPORTED_VIDEO_EXTENSIONS.includes(ext)) {
        return 'video';
    }
    return null;
}

/**
 * Initialize a new upload session
 */
export async function initUploadSession(
    ws: WebSocket,
    totalChunks: number,
    totalSize: number,
    name?: string
): Promise<string> {
    // Create job in database
    const job = await prisma.job.create({
        data: {
            name,
            status: 'uploading',
            totalFiles: 0,
            processedFiles: 0,
        },
    });

    // Create temp directory for this job
    const tempDir = join(tmpdir(), 'pal-uploads', job.id);
    if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true });
    }

    const tempPath = join(tempDir, 'upload.zip');
    const fileStream = createWriteStream(tempPath);

    const session: UploadSession = {
        jobId: job.id,
        tempPath,
        fileStream,
        receivedChunks: 0,
        totalChunks,
        totalSize,
    };

    activeSessions.set(job.id, session);

    // Send job ID back to client
    sendMessage(ws, {
        type: 'status_update',
        jobId: job.id,
        data: { status: 'uploading', processedFiles: 0, totalFiles: 0 },
    });

    return job.id;
}

/**
 * Handle incoming chunk
 */
export async function handleChunk(
    ws: WebSocket,
    jobId: string,
    chunkData: Buffer,
    chunkIndex: number
): Promise<void> {
    const session = activeSessions.get(jobId);

    if (!session) {
        sendError(ws, 'Invalid session');
        return;
    }

    // Write chunk to temp file
    session.fileStream.write(chunkData);
    session.receivedChunks++;

    // Send acknowledgment
    sendMessage(ws, {
        type: 'chunk_ack',
        jobId,
        data: {
            chunkIndex,
            received: session.receivedChunks,
            total: session.totalChunks,
        },
    });

    // Check if upload complete
    if (session.receivedChunks >= session.totalChunks) {
        session.fileStream.end();
        await processUpload(ws, session);
    }
}

/**
 * Process completed upload
 */
async function processUpload(ws: WebSocket, session: UploadSession): Promise<void> {
    const { jobId, tempPath } = session;

    try {
        // Update status
        await updateJobStatus(jobId, 'extracting');
        sendStatusUpdate(ws, jobId, 'extracting');

        // Extract zip
        const zip = new AdmZip(tempPath);
        const entries = zip.getEntries();

        const mediaEntries = entries.filter(entry => {
            if (entry.isDirectory) return false;
            return getMediaType(entry.entryName) !== null;
        });

        // Update total files count
        await prisma.job.update({
            where: { id: jobId },
            data: { totalFiles: mediaEntries.length },
        });

        sendMessage(ws, {
            type: 'status_update',
            jobId,
            data: {
                status: 'extracting',
                totalFiles: mediaEntries.length,
                processedFiles: 0
            },
        });

        // Upload each file to S3
        for (let i = 0; i < mediaEntries.length; i++) {
            const entry = mediaEntries[i];
            const filename = entry.entryName.split('/').pop() || entry.entryName;
            const mediaType = getMediaType(filename);

            if (!mediaType) continue;

            const buffer = entry.getData();
            const mimeType = getMimeType(filename);
            const s3Key = generateS3Key(jobId, filename);

            // Upload to S3
            const { s3Key: key, s3Url } = await uploadToS3(s3Key, buffer, mimeType);

            // Create media file record
            await prisma.mediaFile.create({
                data: {
                    jobId,
                    filename,
                    originalPath: entry.entryName,
                    s3Key: key,
                    s3Url,
                    mediaType,
                    mimeType,
                    sizeBytes: buffer.length,
                },
            });

            // Send progress
            sendMessage(ws, {
                type: 'processing_progress',
                jobId,
                data: {
                    stage: 'extracting',
                    current: i + 1,
                    total: mediaEntries.length,
                    filename,
                },
            });
        }

        // Clean up temp file
        try {
            unlinkSync(tempPath);
        } catch {
            // Ignore cleanup errors
        }

        // Remove session
        activeSessions.delete(jobId);

        // Start processing pipeline
        sendStatusUpdate(ws, jobId, 'processing');

        // Run pipeline in background
        processJob(jobId, (progress) => {
            sendMessage(ws, {
                type: 'processing_progress',
                jobId,
                data: progress,
            });

            if (progress.stage === 'complete') {
                sendStatusUpdate(ws, jobId, 'completed');
            }
        }).catch(async (error) => {
            console.error('Pipeline error:', error);
            sendError(ws, `Processing failed: ${error.message}`);
        });

    } catch (error) {
        console.error('Upload processing error:', error);
        await updateJobStatus(jobId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        sendError(ws, `Processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        activeSessions.delete(jobId);
    }
}

/**
 * Update job status in database
 */
async function updateJobStatus(
    jobId: string,
    status: JobStatus,
    error?: string
): Promise<void> {
    await prisma.job.update({
        where: { id: jobId },
        data: {
            status,
            error,
            ...(status === 'completed' ? { completedAt: new Date() } : {}),
        },
    });
}

/**
 * Send WebSocket message
 */
function sendMessage(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

/**
 * Send status update
 */
async function sendStatusUpdate(ws: WebSocket, jobId: string, status: JobStatus): Promise<void> {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;

    const message: WSStatusMessage = {
        type: 'status_update',
        jobId,
        data: {
            status,
            processedFiles: job.processedFiles,
            totalFiles: job.totalFiles,
        },
    };

    sendMessage(ws, message);
}

/**
 * Send error message
 */
function sendError(ws: WebSocket, message: string): void {
    sendMessage(ws, {
        type: 'error',
        data: { message },
    });
}

/**
 * Get session by job ID
 */
export function getSession(jobId: string): UploadSession | undefined {
    return activeSessions.get(jobId);
}

/**
 * Clean up session on disconnect
 */
export function cleanupSession(jobId: string): void {
    const session = activeSessions.get(jobId);
    if (session) {
        session.fileStream.end();
        try {
            unlinkSync(session.tempPath);
        } catch {
            // Ignore cleanup errors
        }
        activeSessions.delete(jobId);
    }
}
