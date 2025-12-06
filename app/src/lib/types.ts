/**
 * Core type definitions for PAL
 */

// Job status progression
export type JobStatus =
    | 'uploading'
    | 'extracting'
    | 'processing'
    | 'clustering'
    | 'ranking'
    | 'enhancing'
    | 'completed'
    | 'failed';

// Media type discriminator
export type MediaType = 'image' | 'video';

// Supported file extensions
export const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tiff'];
export const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];

// Job summary for API responses
export interface JobSummary {
    id: string;
    status: JobStatus;
    totalFiles: number;
    processedFiles: number;
    progress: number; // 0-100
    error?: string;
    createdAt: Date;
    updatedAt: Date;
    completedAt?: Date;
}

// Media file info
export interface MediaFileInfo {
    id: string;
    filename: string;
    mediaType: MediaType;
    s3Url: string;
    label?: string;
    eloScore: number;
    isTopPick: boolean;
    enhancedS3Url?: string;
}

// Bucket with ranked media
export interface BucketResult {
    id: string;
    name: string;
    topImages: MediaFileInfo[];
    topVideos: MediaFileInfo[];
    allImages: MediaFileInfo[];
    allVideos: MediaFileInfo[];
}

// Job results response
export interface JobResults {
    job: JobSummary;
    buckets: BucketResult[];
}

// WebSocket message types
export type WSMessageType =
    | 'chunk'           // Binary chunk upload
    | 'chunk_ack'       // Chunk received acknowledgment
    | 'upload_complete' // All chunks received
    | 'status_update'   // Job status changed
    | 'error'           // Error occurred
    | 'processing_progress'; // File processing progress

export interface WSMessage {
    type: WSMessageType;
    jobId?: string;
    data?: unknown;
}

export interface WSChunkMessage extends WSMessage {
    type: 'chunk';
    chunkIndex: number;
    totalChunks: number;
    data: ArrayBuffer;
}

export interface WSStatusMessage extends WSMessage {
    type: 'status_update';
    jobId: string;
    data: {
        status: JobStatus;
        processedFiles: number;
        totalFiles: number;
    };
}

export interface WSErrorMessage extends WSMessage {
    type: 'error';
    data: {
        message: string;
        code?: string;
    };
}

// ELO ranking constants
export const ELO_K_FACTOR = 32;
export const ELO_INITIAL_SCORE = 1000;

// Processing configuration
export const PROCESSING_CONCURRENCY = 6;
export const CHUNK_SIZE = 1024 * 1024; // 1MB chunks for upload

// Comparison criteria for tournament ranking
export const IMAGE_COMPARISON_CRITERIA = `
Evaluate these two photographs based on professional photography standards:

1. Technical Quality (sharpness, exposure, noise, dynamic range)
2. Composition (rule of thirds, leading lines, balance, framing)
3. Lighting (quality, direction, mood, highlights/shadows)
4. Color/Tone (vibrancy, harmony, white balance, grading)
5. Subject Impact (engagement, emotion, storytelling)
6. Overall Aesthetic Appeal

Consider this is for a professional photographer selecting their best work.
`;

export const VIDEO_COMPARISON_CRITERIA = `
Evaluate these two video clips based on professional videography standards:

1. Technical Quality (resolution, stability, focus, exposure)
2. Cinematography (framing, camera movement, angles)
3. Lighting (consistency, mood, quality)
4. Color Grading (tone, consistency, professional look)
5. Pacing/Flow (timing, rhythm, engagement)
6. Overall Production Value

Consider this is for a professional selecting their best footage.
`;
