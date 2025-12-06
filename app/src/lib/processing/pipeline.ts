/**
 * Main processing pipeline orchestrator
 * Uses hybrid two-phase clustering with parallelization
 */

import pLimit from 'p-limit';
import prisma from '../prisma';
import { downloadFromS3 } from '../s3';
import {
    generateImageLabel,
    generateVideoLabel,
    generateEmbedding,
    generateClusterName,
    compareImagesSemantically,
    compareImages,
    compareVideos
} from '../gemini';
import { cosineSimilarity } from './clustering';
import { createTournamentRunner, type Competitor } from './tournament';
import { enhanceTopImages } from './enhancer';
import { ELO_INITIAL_SCORE } from '../types';
import type { MediaFile, Bucket } from '@prisma/client';

// Parallelization limits
const LABEL_CONCURRENCY = 10;
const EMBEDDING_CONCURRENCY = 10;
const VISION_CONCURRENCY = 5;
const TOURNAMENT_CONCURRENCY = 3;
const ENHANCE_CONCURRENCY = 3;

const labelLimit = pLimit(LABEL_CONCURRENCY);
const embeddingLimit = pLimit(EMBEDDING_CONCURRENCY);
const visionLimit = pLimit(VISION_CONCURRENCY);
const tournamentLimit = pLimit(TOURNAMENT_CONCURRENCY);

// Configuration
const ROUGH_CLUSTER_THRESHOLD = 0.90;

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
    };

    try {
        await prisma.job.update({ where: { id: jobId }, data: { status: 'processing' } });

        const mediaFiles = await prisma.mediaFile.findMany({ where: { jobId } });
        if (mediaFiles.length === 0) throw new Error('No media files found');

        // ========== STAGE 1: PARALLEL LABELING ==========
        updateProgress('labeling', 0, mediaFiles.length, 'Starting parallel labeling');

        let labeledCount = 0;
        const labeledFiles = await Promise.all(
            mediaFiles.map(file =>
                labelLimit(async () => {
                    const buffer = await downloadFromS3(file.s3Key);
                    const label = file.mediaType === 'video'
                        ? await generateVideoLabel(buffer, file.mimeType)
                        : await generateImageLabel(buffer, file.mimeType);

                    await prisma.mediaFile.update({ where: { id: file.id }, data: { label } });
                    labeledCount++;
                    updateProgress('labeling', labeledCount, mediaFiles.length, file.filename);

                    return { ...file, label, buffer };
                })
            )
        );

        // ========== STAGE 2: PARALLEL EMBEDDING ==========
        await prisma.job.update({ where: { id: jobId }, data: { status: 'processing' } });
        updateProgress('embedding', 0, labeledFiles.length, 'Generating embeddings');

        let embeddedCount = 0;
        const embeddedFiles = await Promise.all(
            labeledFiles.map(file =>
                embeddingLimit(async () => {
                    if (!file.label) return { ...file, embedding: [] as number[] };

                    const embedding = await generateEmbedding(file.label);
                    await prisma.mediaFile.update({ where: { id: file.id }, data: { embedding } });
                    embeddedCount++;
                    updateProgress('embedding', embeddedCount, labeledFiles.length, file.filename);

                    return { ...file, embedding };
                })
            )
        );

        // ========== STAGE 3: HYBRID CLUSTERING ==========
        await prisma.job.update({ where: { id: jobId }, data: { status: 'clustering' } });
        updateProgress('clustering', 0, 1, 'Phase 1: Rough clustering by embedding');

        const filesWithEmbeddings = embeddedFiles.filter(f => f.embedding && f.embedding.length > 0);
        const imageFiles = filesWithEmbeddings.filter(f => f.mediaType === 'image');
        const videoFiles = filesWithEmbeddings.filter(f => f.mediaType === 'video');

        // Phase 1: Rough clustering by embedding
        const embeddings = imageFiles.map(f => f.embedding);
        const roughAssignments = roughClusterByEmbedding(embeddings, ROUGH_CLUSTER_THRESHOLD);
        const numRoughBuckets = Math.max(...roughAssignments) + 1;

        updateProgress('clustering', 0, numRoughBuckets, `Phase 2: Refining ${numRoughBuckets} buckets with vision`);

        // Group by rough bucket
        const roughBuckets = new Map<number, typeof imageFiles>();
        roughAssignments.forEach((c, i) => {
            if (!roughBuckets.has(c)) roughBuckets.set(c, []);
            roughBuckets.get(c)!.push(imageFiles[i]);
        });

        // Phase 2: Semantic refinement within each bucket (parallel)
        const allBucketResults: { name: string; files: typeof imageFiles; avgSim: number }[] = [];
        let bucketsDone = 0;

        await Promise.all(
            Array.from(roughBuckets.entries()).map(async ([_, bucketFiles]) => {
                if (bucketFiles.length === 1) {
                    const labels = bucketFiles.map(f => f.label || '').filter(Boolean);
                    const name = labels.length > 0 ? await generateClusterName(labels) : 'Single Image';
                    allBucketResults.push({ name, files: bucketFiles, avgSim: 1.0 });
                } else {
                    // Build semantic similarity matrix for this bucket
                    const matrix = await buildSemanticMatrix(bucketFiles);
                    const threshold = getOptimalThreshold(matrix);
                    const subAssignments = refineWithSemantic(matrix, threshold);
                    const numSub = Math.max(...subAssignments) + 1;

                    for (let s = 0; s < numSub; s++) {
                        const subIndices = subAssignments.map((a, i) => a === s ? i : -1).filter(i => i !== -1);
                        const subFiles = subIndices.map(i => bucketFiles[i]);
                        const avgSim = calculateAvgSimilarity(subIndices, matrix);

                        const labels = subFiles.map(f => f.label || '').filter(Boolean);
                        const name = labels.length > 0 ? await generateClusterName(labels) : `Cluster ${allBucketResults.length + 1}`;

                        allBucketResults.push({ name, files: subFiles, avgSim });
                    }
                }

                bucketsDone++;
                updateProgress('clustering', bucketsDone, numRoughBuckets, `Refined bucket ${bucketsDone}/${numRoughBuckets}`);
            })
        );

        // Create buckets in database
        for (const result of allBucketResults) {
            const bucket = await prisma.bucket.create({
                data: {
                    jobId,
                    name: result.name,
                    centroid: [], // Not using centroids with hybrid
                },
            });

            await prisma.mediaFile.updateMany({
                where: { id: { in: result.files.map(f => f.id) } },
                data: { bucketId: bucket.id },
            });
        }

        // Handle videos: put all in one bucket or cluster separately
        if (videoFiles.length > 0) {
            const videoLabels = videoFiles.map(f => f.label || '').filter(Boolean);
            const videoName = videoLabels.length > 0 ? await generateClusterName(videoLabels) : 'Videos';

            const videoBucket = await prisma.bucket.create({
                data: { jobId, name: videoName, centroid: [] },
            });

            await prisma.mediaFile.updateMany({
                where: { id: { in: videoFiles.map(f => f.id) } },
                data: { bucketId: videoBucket.id },
            });
        }

        updateProgress('clustering', numRoughBuckets, numRoughBuckets, `Created ${allBucketResults.length} image clusters`);

        // ========== STAGE 4: PARALLEL TOURNAMENT RANKING ==========
        await prisma.job.update({ where: { id: jobId }, data: { status: 'ranking' } });

        const buckets = await prisma.bucket.findMany({
            where: { jobId },
            include: { mediaFiles: true },
        });

        updateProgress('ranking', 0, buckets.length, 'Running parallel tournaments');

        let tournamentsDone = 0;
        await Promise.all(
            buckets.map(bucket =>
                tournamentLimit(async () => {
                    const images = bucket.mediaFiles.filter(f => f.mediaType === 'image');
                    if (images.length > 1) {
                        await runBucketTournament(bucket, images, 'image');
                    }

                    const videos = bucket.mediaFiles.filter(f => f.mediaType === 'video');
                    if (videos.length > 1) {
                        await runBucketTournament(bucket, videos, 'video');
                    }

                    tournamentsDone++;
                    updateProgress('ranking', tournamentsDone, buckets.length, bucket.name);
                })
            )
        );

        // Mark top 3 from each bucket
        await Promise.all(
            buckets.map(async bucket => {
                const topImages = await prisma.mediaFile.findMany({
                    where: { bucketId: bucket.id, mediaType: 'image' },
                    orderBy: { eloScore: 'desc' },
                    take: 3,
                });
                for (const img of topImages) {
                    await prisma.mediaFile.update({ where: { id: img.id }, data: { isTopPick: true } });
                }

                const topVideos = await prisma.mediaFile.findMany({
                    where: { bucketId: bucket.id, mediaType: 'video' },
                    orderBy: { eloScore: 'desc' },
                    take: 3,
                });
                for (const vid of topVideos) {
                    await prisma.mediaFile.update({ where: { id: vid.id }, data: { isTopPick: true } });
                }
            })
        );

        // ========== STAGE 5: PARALLEL ENHANCEMENT ==========
        await prisma.job.update({ where: { id: jobId }, data: { status: 'enhancing' } });
        updateProgress('enhancing', 0, 1, 'Enhancing top picks');

        await enhanceTopImages(jobId, 3);

        updateProgress('enhancing', 1, 1, 'Enhancement complete');

        // ========== COMPLETE ==========
        await prisma.job.update({
            where: { id: jobId },
            data: { status: 'completed', completedAt: new Date() },
        });

        updateProgress('complete', 1, 1, 'Job completed');

    } catch (error) {
        console.error('Pipeline error:', error);
        await prisma.job.update({
            where: { id: jobId },
            data: { status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' },
        });
        throw error;
    }
}

// ========== HELPER FUNCTIONS ==========

function roughClusterByEmbedding(embeddings: number[][], threshold: number): number[] {
    const n = embeddings.length;
    if (n === 0) return [];

    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => parent[x] !== x ? (parent[x] = find(parent[x])) : x;

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (cosineSimilarity(embeddings[i], embeddings[j]) >= threshold) {
                parent[find(i)] = find(j);
            }
        }
    }

    const map = new Map<number, number>();
    return Array.from({ length: n }, (_, i) => {
        const root = find(i);
        if (!map.has(root)) map.set(root, map.size);
        return map.get(root)!;
    });
}

async function buildSemanticMatrix(files: { buffer: Buffer; mimeType: string }[]): Promise<number[][]> {
    const n = files.length;
    const matrix = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) matrix[i][i] = 1.0;

    const pairs: { i: number; j: number }[] = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) pairs.push({ i, j });
    }

    await Promise.all(
        pairs.map(({ i, j }) =>
            visionLimit(async () => {
                try {
                    const r = await compareImagesSemantically(
                        files[i].buffer, files[i].mimeType,
                        files[j].buffer, files[j].mimeType
                    );
                    matrix[i][j] = matrix[j][i] = r.similarity;
                } catch {
                    matrix[i][j] = matrix[j][i] = 0.5;
                }
            })
        )
    );

    return matrix;
}

function refineWithSemantic(matrix: number[][], threshold: number): number[] {
    const n = matrix.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => parent[x] !== x ? (parent[x] = find(parent[x])) : x;

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (matrix[i][j] >= threshold) parent[find(i)] = find(j);
        }
    }

    const map = new Map<number, number>();
    return Array.from({ length: n }, (_, i) => {
        const root = find(i);
        if (!map.has(root)) map.set(root, map.size);
        return map.get(root)!;
    });
}

function getOptimalThreshold(matrix: number[][]): number {
    const sims: number[] = [];
    for (let i = 0; i < matrix.length; i++) {
        for (let j = i + 1; j < matrix.length; j++) sims.push(matrix[i][j]);
    }
    if (sims.length === 0) return 0.7;
    sims.sort((a, b) => a - b);
    return Math.max(0.55, Math.min(0.85, sims[Math.floor(sims.length / 2)] + 0.05));
}

function calculateAvgSimilarity(indices: number[], matrix: number[][]): number {
    if (indices.length < 2) return 1.0;
    let sum = 0, count = 0;
    for (let i = 0; i < indices.length; i++) {
        for (let j = i + 1; j < indices.length; j++) {
            sum += matrix[indices[i]][indices[j]];
            count++;
        }
    }
    return count > 0 ? sum / count : 1.0;
}

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

    const tournament = createTournamentRunner(competitors, {
        type: files.length > 10 ? 'single-elimination' : 'round-robin'
    });

    const matchups = tournament.getNextMatchups();

    // Run matchups in parallel (limited concurrency)
    await Promise.all(
        matchups.map(([idx1, idx2]) =>
            tournamentLimit(async () => {
                if (idx2 === -1) return;

                const comp1 = tournament.getCompetitor(idx1);
                const comp2 = tournament.getCompetitor(idx2);

                const [buffer1, buffer2] = await Promise.all([
                    downloadFromS3(comp1.file.s3Key),
                    downloadFromS3(comp2.file.s3Key),
                ]);

                const result = mediaType === 'video'
                    ? await compareVideos(buffer1, comp1.file.mimeType, comp1.file.label || '', buffer2, comp2.file.mimeType, comp2.file.label || '')
                    : await compareImages(buffer1, comp1.file.mimeType, comp1.file.label || '', buffer2, comp2.file.mimeType, comp2.file.label || '');

                const winnerId = result.winner === 1 ? comp1.id : comp2.id;
                tournament.recordResult(idx1, idx2, winnerId, result.reasoning, result.confidence);

                await prisma.tournamentMatch.create({
                    data: {
                        bucketId: bucket.id,
                        mediaType,
                        round: 1,
                        media1Id: comp1.id,
                        media2Id: comp2.id,
                        winnerId,
                        reasoning: result.reasoning,
                        media1EloChange: result.winner === 1 ? 16 : -16,
                        media2EloChange: result.winner === 2 ? 16 : -16,
                    },
                });
            })
        )
    );

    // Update ELO scores
    const results = tournament.getResults();
    await Promise.all(
        results.rankedCompetitors.map(comp =>
            prisma.mediaFile.update({ where: { id: comp.id }, data: { eloScore: comp.eloScore } })
        )
    );
}

export { processJob as default };
