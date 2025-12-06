/**
 * PAL API Client - Strongly typed client for frontend usage
 * Handles WebSocket connections for uploads and REST API for status/results
 */

import type {
    JobSummary,
    JobResults,
    BucketResult,
    WSMessage,
    JobStatus,
} from './types';
import { CHUNK_SIZE } from './types';

export interface UploadProgress {
    stage: 'uploading' | 'extracting' | 'processing';
    percent: number;
    currentFile?: string;
    chunksUploaded?: number;
    totalChunks?: number;
}

export interface ProcessingProgress {
    stage: string;
    current: number;
    total: number;
    message?: string;
}

type ProgressCallback = (progress: UploadProgress | ProcessingProgress) => void;
type StatusCallback = (status: JobStatus) => void;
type ErrorCallback = (error: Error) => void;

/**
 * PAL API Client class for frontend integration
 */
export class PALClient {
    private baseUrl: string;
    private wsUrl: string;
    private ws: WebSocket | null = null;
    private currentJobId: string | null = null;

    constructor(options?: { baseUrl?: string; wsUrl?: string }) {
        // Default to current origin
        const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
        this.baseUrl = options?.baseUrl || origin;

        const wsProtocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
        const wsHost = this.baseUrl.replace(/^https?:\/\//, '');
        this.wsUrl = options?.wsUrl || `${wsProtocol}://${wsHost}/ws/upload`;
    }

    // ========== REST API Methods ==========

    /**
     * List all jobs
     */
    async listJobs(options?: { limit?: number; offset?: number }): Promise<{
        jobs: JobSummary[];
        total: number;
    }> {
        const params = new URLSearchParams();
        if (options?.limit) params.set('limit', String(options.limit));
        if (options?.offset) params.set('offset', String(options.offset));

        const response = await fetch(`${this.baseUrl}/api/jobs?${params}`);
        if (!response.ok) {
            throw new Error(`Failed to list jobs: ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Get job status
     */
    async getJobStatus(jobId: string): Promise<JobSummary & {
        mediaFilesCount: number;
        bucketsCount: number;
    }> {
        const response = await fetch(`${this.baseUrl}/api/jobs/${jobId}`);
        if (!response.ok) {
            throw new Error(`Failed to get job: ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Get job results
     */
    async getResults(jobId: string): Promise<JobResults> {
        const response = await fetch(`${this.baseUrl}/api/jobs/${jobId}/results`);
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || `Failed to get results: ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Delete a job
     */
    async deleteJob(jobId: string): Promise<void> {
        const response = await fetch(`${this.baseUrl}/api/jobs/${jobId}`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            throw new Error(`Failed to delete job: ${response.statusText}`);
        }
    }

    // ========== WebSocket Upload Methods ==========

    /**
     * Upload a zip file with progress tracking
     */
    async uploadZip(
        file: File,
        callbacks?: {
            onProgress?: ProgressCallback;
            onStatus?: StatusCallback;
            onError?: ErrorCallback;
        }
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            // Connect to WebSocket
            this.ws = new WebSocket(this.wsUrl);

            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            let uploadedChunks = 0;

            this.ws.onopen = () => {
                // Send initialization message
                this.ws!.send(JSON.stringify({
                    type: 'init',
                    totalChunks,
                    totalSize: file.size,
                }));
            };

            this.ws.onmessage = async (event) => {
                try {
                    const message: WSMessage = JSON.parse(event.data);

                    switch (message.type) {
                        case 'status_update': {
                            const data = message.data as {
                                status: JobStatus;
                                totalFiles: number;
                                processedFiles: number;
                            };

                            // Store job ID on first status update
                            if (message.jobId && !this.currentJobId) {
                                this.currentJobId = message.jobId;
                            }

                            callbacks?.onStatus?.(data.status);

                            // If upload stage, start sending chunks
                            if (data.status === 'uploading' && uploadedChunks === 0) {
                                this.sendChunks(file, totalChunks, (chunksUploaded) => {
                                    uploadedChunks = chunksUploaded;
                                    callbacks?.onProgress?.({
                                        stage: 'uploading',
                                        percent: Math.round((chunksUploaded / totalChunks) * 100),
                                        chunksUploaded,
                                        totalChunks,
                                    });
                                });
                            }

                            // Resolve when completed
                            if (data.status === 'completed') {
                                resolve(this.currentJobId!);
                                this.disconnect();
                            }
                            break;
                        }

                        case 'chunk_ack': {
                            const data = message.data as {
                                chunkIndex: number;
                                received: number;
                                total: number;
                            };
                            callbacks?.onProgress?.({
                                stage: 'uploading',
                                percent: Math.round((data.received / data.total) * 100),
                                chunksUploaded: data.received,
                                totalChunks: data.total,
                            });
                            break;
                        }

                        case 'processing_progress': {
                            const data = message.data as ProcessingProgress;
                            callbacks?.onProgress?.(data);
                            break;
                        }

                        case 'error': {
                            const data = message.data as { message: string };
                            const error = new Error(data.message);
                            callbacks?.onError?.(error);
                            reject(error);
                            this.disconnect();
                            break;
                        }
                    }
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            };

            this.ws.onerror = (event) => {
                const error = new Error('WebSocket connection error');
                callbacks?.onError?.(error);
                reject(error);
            };

            this.ws.onclose = () => {
                // If closed unexpectedly before completion
                if (!this.currentJobId) {
                    const error = new Error('Connection closed unexpectedly');
                    callbacks?.onError?.(error);
                    reject(error);
                }
            };
        });
    }

    /**
     * Send file chunks over WebSocket
     */
    private async sendChunks(
        file: File,
        totalChunks: number,
        onChunkSent: (count: number) => void
    ): Promise<void> {
        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            const arrayBuffer = await chunk.arrayBuffer();

            // Create buffer with chunk index prefix
            const indexBuffer = new ArrayBuffer(4);
            new DataView(indexBuffer).setUint32(0, i);

            const combinedBuffer = new Uint8Array(4 + arrayBuffer.byteLength);
            combinedBuffer.set(new Uint8Array(indexBuffer), 0);
            combinedBuffer.set(new Uint8Array(arrayBuffer), 4);

            // Wait for WebSocket to be ready
            while (this.ws?.readyState !== WebSocket.OPEN) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            this.ws.send(combinedBuffer);
            onChunkSent(i + 1);

            // Small delay to prevent overwhelming the connection
            if (i % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }
    }

    /**
     * Subscribe to job updates via polling
     */
    subscribeToUpdates(
        jobId: string,
        callback: (job: JobSummary) => void,
        intervalMs = 2000
    ): () => void {
        let isActive = true;

        const poll = async () => {
            while (isActive) {
                try {
                    const job = await this.getJobStatus(jobId);
                    callback(job);

                    if (job.status === 'completed' || job.status === 'failed') {
                        break;
                    }
                } catch (error) {
                    console.error('Polling error:', error);
                }

                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        };

        poll();

        // Return unsubscribe function
        return () => {
            isActive = false;
        };
    }

    /**
     * Disconnect WebSocket
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.currentJobId = null;
    }

    /**
     * Get current job ID
     */
    getCurrentJobId(): string | null {
        return this.currentJobId;
    }
}

// Export singleton instance for convenience
export const palClient = new PALClient();

export default PALClient;
