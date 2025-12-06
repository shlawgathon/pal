/**
 * Main processing pipeline orchestrator
 */

import pLimit from 'p-limit';
import prisma from '../prisma';
import { downloadFromS3 } from '../s3';
import {
    generateImageLabel,
    generateVideoLabel,
    generateEmbedding,
    generateClusterName,
    compareImages,
    compareVideos
} from '../gemini';
import { kMeansClustering, findOptimalK } from './clustering';
import { createTournamentRunner, type Competitor } from './tournament';
import { enhanceTopImages } from './enhancer';
import { PROCESSING_CONCURRENCY, ELO_INITIAL_SCORE } from '../types';
import type { Job, MediaFile, Bucket } from '@prisma/client';

// Concurrency limiter
const limit = pLimit(PROCESSING_CONCURRENCY);

export interface ProcessingProgress {
    stage: string;
    current: number;
    total: number;
    message?: string;
}

export type ProgressCallback = (progress: ProcessingProgress) => void;

/**
 * Main processing pipeline for a job
 */
export async function processJob(
    jobId: string,
    onProgress?: ProgressCallback
): Promise<void> {
    const updateProgress = (stage: string, current: number, total: number, message?: string) => {
        onProgress?.({ stage, current, total, message });
        console.log(`[${stage}] ${current}/${total} - ${message || ''}`);
    };

    try {
        // Update job status to processing
        await prisma.job.update({
            where: { id: jobId },
            data: { status: 'processing' },
        });

        // Get all media files for the job
        const mediaFiles = await prisma.mediaFile.findMany({
            where: { jobId },
        });

        if (mediaFiles.length === 0) {
            throw new Error('No media files found for job');
        }

        // ========== STAGE 1: LABELING ==========
        updateProgress('labeling', 0, mediaFiles.length, 'Starting image labeling');

        const labelingTasks = mediaFiles.map((file, index) =>
            limit(async () => {
                const label = await labelMediaFile(file);

                await prisma.mediaFile.update({
                    where: { id: file.id },
                    data: { label },
                });

                await prisma.job.update({
                    where: { id: jobId },
                    data: { processedFiles: { increment: 1 } },
                });

                updateProgress('labeling', index + 1, mediaFiles.length, `Labeled: ${file.filename}`);

                return { ...file, label };
            })
        );

        const labeledFiles = await Promise.all(labelingTasks);

        // ========== STAGE 2: EMBEDDING ==========
        await prisma.job.update({
            where: { id: jobId },
            data: { status: 'processing', processedFiles: 0 },
        });

        updateProgress('embedding', 0, labeledFiles.length, 'Generating embeddings');

        const embeddingTasks = labeledFiles.map((file, index) =>
            limit(async () => {
                if (!file.label) return file;

                const embedding = await generateEmbedding(file.label);

                await prisma.mediaFile.update({
                    where: { id: file.id },
                    data: { embedding },
                });

                updateProgress('embedding', index + 1, labeledFiles.length, `Embedded: ${file.filename}`);

                return { ...file, embedding };
            })
        );

        const embeddedFiles = await Promise.all(embeddingTasks);

        // ========== STAGE 3: CLUSTERING ==========
        await prisma.job.update({
            where: { id: jobId },
            data: { status: 'clustering' },
        });

        updateProgress('clustering', 0, 1, 'Clustering similar images');

        // Only cluster files with embeddings
        const filesWithEmbeddings = embeddedFiles.filter(
            f => f.embedding && f.embedding.length > 0
        );

        if (filesWithEmbeddings.length === 0) {
            throw new Error('No files with embeddings to cluster');
        }

        const embeddings = filesWithEmbeddings.map(f => f.embedding!);

        // Find optimal number of clusters
        const optimalK = findOptimalK(embeddings, Math.min(10, Math.floor(filesWithEmbeddings.length / 3)));
        const clusterResult = kMeansClustering(embeddings, Math.max(1, optimalK));

        // Create buckets and assign files
        for (const cluster of clusterResult.clusters) {
            const clusterFiles = cluster.memberIndices.map(i => filesWithEmbeddings[i]);
            const labels = clusterFiles.map(f => f.label || '').filter(Boolean);

            // Generate cluster name
            const name = labels.length > 0
                ? await generateClusterName(labels)
                : `Cluster ${cluster.clusterIndex + 1}`;

            // Create bucket
            const bucket = await prisma.bucket.create({
                data: {
                    jobId,
                    name,
                    centroid: cluster.centroid,
                },
            });

            // Assign files to bucket
            await prisma.mediaFile.updateMany({
                where: {
                    id: { in: clusterFiles.map(f => f.id) },
                },
                data: {
                    bucketId: bucket.id,
                },
            });
        }

        updateProgress('clustering', 1, 1, `Created ${clusterResult.clusters.length} clusters`);

        // ========== STAGE 4: TOURNAMENT RANKING ==========
        await prisma.job.update({
            where: { id: jobId },
            data: { status: 'ranking' },
        });

        const buckets = await prisma.bucket.findMany({
            where: { jobId },
            include: { mediaFiles: true },
        });

        updateProgress('ranking', 0, buckets.length, 'Running tournaments');

        for (let i = 0; i < buckets.length; i++) {
            const bucket = buckets[i];

            // Run image tournament
            const images = bucket.mediaFiles.filter(f => f.mediaType === 'image');
            if (images.length > 1) {
                await runBucketTournament(bucket, images, 'image');
            }

            // Run video tournament (separate)
            const videos = bucket.mediaFiles.filter(f => f.mediaType === 'video');
            if (videos.length > 1) {
                await runBucketTournament(bucket, videos, 'video');
            }

            updateProgress('ranking', i + 1, buckets.length, `Ranked bucket: ${bucket.name}`);
        }

        // Mark top 3 from each bucket
        for (const bucket of buckets) {
            // Top 3 images
            const topImages = await prisma.mediaFile.findMany({
                where: { bucketId: bucket.id, mediaType: 'image' },
                orderBy: { eloScore: 'desc' },
                take: 3,
            });

            for (const img of topImages) {
                await prisma.mediaFile.update({
                    where: { id: img.id },
                    data: { isTopPick: true },
                });
            }

            // Top 3 videos
            const topVideos = await prisma.mediaFile.findMany({
                where: { bucketId: bucket.id, mediaType: 'video' },
                orderBy: { eloScore: 'desc' },
                take: 3,
            });

            for (const vid of topVideos) {
                await prisma.mediaFile.update({
                    where: { id: vid.id },
                    data: { isTopPick: true },
                });
            }
        }

        // ========== STAGE 5: ENHANCEMENT ==========
        await prisma.job.update({
            where: { id: jobId },
            data: { status: 'enhancing' },
        });

        updateProgress('enhancing', 0, 1, 'Enhancing top images');

        await enhanceTopImages(jobId, 3);

        updateProgress('enhancing', 1, 1, 'Enhancement complete');

        // ========== COMPLETE ==========
        await prisma.job.update({
            where: { id: jobId },
            data: {
                status: 'completed',
                completedAt: new Date(),
            },
        });

        updateProgress('complete', 1, 1, 'Job completed successfully');

    } catch (error) {
        console.error('Pipeline error:', error);

        await prisma.job.update({
            where: { id: jobId },
            data: {
                status: 'failed',
                error: error instanceof Error ? error.message : 'Unknown error',
            },
        });

        throw error;
    }
}

/**
 * Generate label for a media file
 */
async function labelMediaFile(file: MediaFile): Promise<string> {
    const buffer = await downloadFromS3(file.s3Key);

    if (file.mediaType === 'video') {
        return generateVideoLabel(buffer, file.mimeType);
    }

    return generateImageLabel(buffer, file.mimeType);
}

/**
 * Run tournament for a bucket's media files
 */
async function runBucketTournament(
    bucket: Bucket,
    files: MediaFile[],
    mediaType: 'image' | 'video'
): Promise<void> {
    if (files.length < 2) return;

    const competitors: (Competitor & { file: MediaFile })[] = files.map(f => ({
        id: f.id,
        eloScore: ELO_INITIAL_SCORE,
        file: f,
    }));

    // Use single-elimination for efficiency with large sets
    const tournament = createTournamentRunner(competitors, {
        type: files.length > 10 ? 'single-elimination' : 'round-robin'
    });

    const matchups = tournament.getNextMatchups();

    for (const [idx1, idx2] of matchups) {
        if (idx2 === -1) continue; // Skip byes

        const comp1 = tournament.getCompetitor(idx1);
        const comp2 = tournament.getCompetitor(idx2);

        // Download files for comparison
        const [buffer1, buffer2] = await Promise.all([
            downloadFromS3(comp1.file.s3Key),
            downloadFromS3(comp2.file.s3Key),
        ]);

        // Run comparison
        let result;
        if (mediaType === 'video') {
            result = await compareVideos(
                buffer1, comp1.file.mimeType, comp1.file.label || '',
                buffer2, comp2.file.mimeType, comp2.file.label || ''
            );
        } else {
            result = await compareImages(
                buffer1, comp1.file.mimeType, comp1.file.label || '',
                buffer2, comp2.file.mimeType, comp2.file.label || ''
            );
        }

        const winnerId = result.winner === 1 ? comp1.id : comp2.id;
        tournament.recordResult(idx1, idx2, winnerId, result.reasoning, result.confidence);

        // Record match in database
        await prisma.tournamentMatch.create({
            data: {
                bucketId: bucket.id,
                mediaType,
                round: 1,
                media1Id: comp1.id,
                media2Id: comp2.id,
                winnerId,
                reasoning: result.reasoning,
                media1EloChange: result.winner === 1
                    ? (tournament.getCompetitor(idx1).eloScore - ELO_INITIAL_SCORE)
                    : (ELO_INITIAL_SCORE - tournament.getCompetitor(idx1).eloScore),
                media2EloChange: result.winner === 2
                    ? (tournament.getCompetitor(idx2).eloScore - ELO_INITIAL_SCORE)
                    : (ELO_INITIAL_SCORE - tournament.getCompetitor(idx2).eloScore),
            },
        });
    }

    // Update ELO scores in database
    const results = tournament.getResults();
    for (const comp of results.rankedCompetitors) {
        await prisma.mediaFile.update({
            where: { id: comp.id },
            data: { eloScore: comp.eloScore },
        });
    }
}

export { processJob as default };
