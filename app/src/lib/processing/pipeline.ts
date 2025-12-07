/**
 * Main processing pipeline orchestrator
 * Uses Union-Find clustering with LLM comparison and round-robin ranking
 */

import pLimit from 'p-limit';
import prisma from '../prisma';
import { downloadFromS3 } from '../s3';
import {
    generateImageLabel,
    generateVideoLabel,
    generateClusterName,
    compareImages,
    compareVideos
} from '../gemini';
import { ELO_INITIAL_SCORE, ELO_K_FACTOR } from '../types';
import type { MediaFile, Bucket } from '@prisma/client';

// Parallelization limits - high concurrency for faster processing
const LABEL_CONCURRENCY = 65;
const COMPARE_CONCURRENCY = 20;
const RANK_CONCURRENCY = 8;
const MERGE_CONCURRENCY = 40;

const labelLimit = pLimit(LABEL_CONCURRENCY);
const compareLimit = pLimit(COMPARE_CONCURRENCY);
const rankLimit = pLimit(RANK_CONCURRENCY);
const mergeLimit = pLimit(MERGE_CONCURRENCY);

export interface ProcessingProgress {
    stage: string;
    current: number;
    total: number;
    message?: string;
}

export type ProgressCallback = (progress: ProcessingProgress) => void;

/**
 * Race multiple promises and return the first result that matches the predicate.
 * If no result matches, returns null after all promises complete.
 * This enables parallel execution with early exit optimization.
 */
async function raceToFirstMatch<T>(
    promises: Promise<T>[],
    predicate: (result: T) => boolean
): Promise<T | null> {
    if (promises.length === 0) return null;

    return new Promise((resolve) => {
        let completed = 0;
        let resolved = false;

        promises.forEach(promise => {
            promise.then(result => {
                if (!resolved) {
                    if (predicate(result)) {
                        // Found a match - resolve immediately
                        resolved = true;
                        resolve(result);
                    } else {
                        // No match - check if all completed
                        completed++;
                        if (completed === promises.length) {
                            resolve(null); // No match found in any promise
                        }
                    }
                }
            }).catch(() => {
                // On error, count as completed but don't match
                completed++;
                if (!resolved && completed === promises.length) {
                    resolve(null);
                }
            });
        });
    });
}

/**
 * Compare two images to determine if they are the same "take"
 * Returns true if same, false if different
 */
async function areSameTake(
    buffer1: Buffer, mimeType1: string,
    buffer2: Buffer, mimeType2: string
): Promise<boolean> {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

    const prompt = `We are trying to dedup a list of images. You are acting as an agent that is part of a larger system to rank takes of the same shot.
    
Your job is to decide whether these two photos are the exact same take of an image or if they are not.

A photo is the same take if it is:
- slightly different positioning of the same object, but obviously taken at the same time
- slightly different shading, but obviously taken at the exact same time

A photo is a different take if it is:
- the same object but taken at a different time
- a different object taken at a different time

If you think that they are the exact same take, output the word "SAME". if they are different images, output the word "DIFFERENT".
`;

    try {
        const result = await model.generateContent([
            prompt,
            { inlineData: { mimeType: mimeType1, data: buffer1.toString('base64') } },
            { inlineData: { mimeType: mimeType2, data: buffer2.toString('base64') } },
        ]);

        const response = result.response.text().trim().toUpperCase();
        return response.includes('SAME');
    } catch (error) {
        console.error(`[Pipeline] Compare error:`, error);
        return false;
    }
}

/**
 * Main processing pipeline for a job
 */
export async function processJob(
    jobId: string,
    onProgress?: ProgressCallback
): Promise<void> {
    const updateProgress = async (stage: string, current: number, total: number, message?: string) => {
        console.log(`[Pipeline] [${stage}] ${current}/${total} - ${message || ''}`);
        onProgress?.({ stage, current, total, message });

        await prisma.job.update({
            where: { id: jobId },
            data: { processedFiles: current, totalFiles: total },
        });
    };

    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[Pipeline] Starting job: ${jobId}`);
        console.log(`${'='.repeat(60)}\n`);

        // Get job and determine starting stage
        const job = await prisma.job.findUnique({ where: { id: jobId } });
        if (!job) throw new Error('Job not found');

        const currentStatus = job.status;
        console.log(`[Pipeline] Current job status: ${currentStatus}`);

        // Define stage order
        const stages = ['labeling', 'clustering', 'merging', 'ranking', 'enhancing', 'completed', 'failed'];
        const currentStageIndex = stages.indexOf(currentStatus);

        // Helper function to determine if a stage should run
        const shouldRunStage = (stageName: string): boolean => {
            const stageIndex = stages.indexOf(stageName);
            // Run if current stage matches or we're before it
            return currentStageIndex <= stageIndex && currentStatus !== 'completed' && currentStatus !== 'failed';
        };

        const mediaFiles = await prisma.mediaFile.findMany({ where: { jobId } });
        console.log(`[Pipeline] Found ${mediaFiles.length} media files`);
        if (mediaFiles.length === 0) throw new Error('No media files found');

        // ========== STAGE 1: PARALLEL LABELING ==========
        let filesWithData: Array<typeof mediaFiles[0] & { label: string; buffer: Buffer }>;

        if (shouldRunStage('labeling')) {
            console.log(`\n[Pipeline] ═══ STAGE 1: LABELING (${LABEL_CONCURRENCY} parallel) ═══`);
            await prisma.job.update({ where: { id: jobId }, data: { status: 'labeling', totalFiles: mediaFiles.length, processedFiles: 0 } });
            await updateProgress('labeling', 0, mediaFiles.length, 'Starting');

            let labeledCount = 0;
            filesWithData = await Promise.all(
                mediaFiles.map(file =>
                    labelLimit(async () => {
                        const buffer = await downloadFromS3(file.s3Key);

                        // Skip if already labeled
                        let label = file.label;
                        if (!label) {
                            label = file.mediaType === 'video'
                                ? await generateVideoLabel(buffer, file.mimeType)
                                : await generateImageLabel(buffer, file.mimeType);

                            await prisma.mediaFile.update({ where: { id: file.id }, data: { label } });
                            labeledCount++;
                            console.log(`[Pipeline] Labeled ${labeledCount}/${mediaFiles.length}: ${file.filename} -> "${label}"`);
                        } else {
                            console.log(`[Pipeline] Skipping ${file.filename} (already labeled)`);
                        }

                        await updateProgress('labeling', labeledCount, mediaFiles.length, file.filename);

                        return { ...file, label, buffer };
                    })
                )
            );

            console.log(`[Pipeline] Labeling complete`);
        } else {
            console.log(`\n[Pipeline] ═══ SKIPPING STAGE 1: LABELING (already completed) ═══`);
            // Load existing data
            filesWithData = await Promise.all(
                mediaFiles.map(async (file) => {
                    const buffer = await downloadFromS3(file.s3Key);
                    return { ...file, label: file.label || '', buffer };
                })
            );
        }

        // ========== STAGE 2: UNION-FIND CLUSTERING ==========
        console.log(`\n[Pipeline] ═══ STAGE 2: UNION-FIND CLUSTERING ═══`);
        await prisma.job.update({ where: { id: jobId }, data: { status: 'clustering', processedFiles: 0 } });
        await updateProgress('clustering', 0, filesWithData.length, 'Starting union-find');

        const imageFiles = filesWithData.filter(f => f.mediaType === 'image');
        const videoFiles = filesWithData.filter(f => f.mediaType === 'video');

        // Union-find clustering for images
        interface TempBucket {
            representative: typeof imageFiles[0];
            files: typeof imageFiles;
        }
        const tempBuckets: TempBucket[] = [];

        for (let i = 0; i < imageFiles.length; i++) {
            const file = imageFiles[i];
            console.log(`[Pipeline] Clustering ${i + 1}/${imageFiles.length}: ${file.filename}`);

            let matchedBucket: TempBucket | null = null;

            if (tempBuckets.length > 0) {
                // Launch all bucket comparisons in parallel with controlled concurrency
                const comparisons = tempBuckets.map((bucket, bucketIndex) =>
                    compareLimit(async () => {
                        const isSame = await areSameTake(
                            file.buffer, file.mimeType,
                            bucket.representative.buffer, bucket.representative.mimeType
                        );
                        console.log(`    vs "${bucket.representative.filename}" = ${isSame ? 'SAME' : 'DIFFERENT'}`);
                        return { bucketIndex, isSame };
                    })
                );

                // Race to first match - exits immediately when found
                const result = await raceToFirstMatch(
                    comparisons,
                    (r) => r.isSame
                );

                if (result) {
                    matchedBucket = tempBuckets[result.bucketIndex];
                    console.log(`    -> Match found with bucket #${result.bucketIndex + 1}! (early exit)`);
                }
            }

            if (matchedBucket) {
                matchedBucket.files.push(file);
                console.log(`    -> Added to existing bucket (${matchedBucket.files.length} files)`);
            } else {
                tempBuckets.push({ representative: file, files: [file] });
                console.log(`    -> Created new bucket #${tempBuckets.length}`);
            }

            await updateProgress('clustering', i + 1, imageFiles.length, file.filename);
        }

        console.log(`[Pipeline] Created ${tempBuckets.length} image buckets (before merge)`);

        // ========== STAGE 2.5: BUCKET MERGE SORT ==========
        console.log(`\n[Pipeline] ═══ STAGE 2.5: BUCKET MERGE ═══`);
        await updateProgress('merging', 0, tempBuckets.length, 'Comparing bucket representatives');

        // Union-Find for merging similar buckets
        const parent: number[] = tempBuckets.map((_, i) => i);
        const rank: number[] = new Array(tempBuckets.length).fill(0);

        const find = (x: number): number => {
            if (parent[x] !== x) {
                parent[x] = find(parent[x]); // Path compression
            }
            return parent[x];
        };

        const union = (x: number, y: number): void => {
            const rootX = find(x);
            const rootY = find(y);
            if (rootX === rootY) return;

            // Union by rank
            if (rank[rootX] < rank[rootY]) {
                parent[rootX] = rootY;
            } else if (rank[rootX] > rank[rootY]) {
                parent[rootY] = rootX;
            } else {
                parent[rootY] = rootX;
                rank[rootX]++;
            }
        };

        // Generate all pairs of buckets to compare
        const bucketPairs: { i: number; j: number }[] = [];
        for (let i = 0; i < tempBuckets.length; i++) {
            for (let j = i + 1; j < tempBuckets.length; j++) {
                bucketPairs.push({ i, j });
            }
        }

        console.log(`[Pipeline] Comparing ${bucketPairs.length} bucket pairs in parallel`);

        // Compare all bucket representative pairs in parallel
        let mergeComparisons = 0;
        const mergeResults = await Promise.all(
            bucketPairs.map(({ i, j }) =>
                mergeLimit(async () => {
                    const bucket1 = tempBuckets[i];
                    const bucket2 = tempBuckets[j];

                    const isSame = await areSameTake(
                        bucket1.representative.buffer, bucket1.representative.mimeType,
                        bucket2.representative.buffer, bucket2.representative.mimeType
                    );

                    mergeComparisons++;
                    if (mergeComparisons % 20 === 0 || mergeComparisons === bucketPairs.length) {
                        console.log(`[Pipeline] Merge comparisons: ${mergeComparisons}/${bucketPairs.length}`);
                    }

                    return { i, j, isSame };
                })
            )
        );

        // Union all matching bucket pairs
        let mergedCount = 0;
        for (const { i, j, isSame } of mergeResults) {
            if (isSame) {
                console.log(`[Pipeline] Merging bucket #${i + 1} (${tempBuckets[i].representative.filename}) with bucket #${j + 1} (${tempBuckets[j].representative.filename})`);
                union(i, j);
                mergedCount++;
            }
        }

        console.log(`[Pipeline] Merged ${mergedCount} bucket pairs`);

        // Group buckets by their root
        const mergedBuckets: Map<number, TempBucket> = new Map();
        for (let i = 0; i < tempBuckets.length; i++) {
            const root = find(i);
            if (!mergedBuckets.has(root)) {
                mergedBuckets.set(root, {
                    representative: tempBuckets[root].representative,
                    files: [],
                });
            }
            // Add all files from this bucket to the merged bucket
            mergedBuckets.get(root)!.files.push(...tempBuckets[i].files);
        }

        const finalBuckets = Array.from(mergedBuckets.values());
        console.log(`[Pipeline] Final bucket count: ${finalBuckets.length} (merged from ${tempBuckets.length})`);
        await updateProgress('merging', tempBuckets.length, tempBuckets.length, `Merged to ${finalBuckets.length} buckets`);

        // Create buckets in database with names
        for (let i = 0; i < finalBuckets.length; i++) {
            const tempBucket = finalBuckets[i];
            const labels = tempBucket.files.map(f => f.label || '').filter(Boolean);
            const name = labels.length > 0 ? await generateClusterName(labels) : `Bucket ${i + 1}`;

            console.log(`[Pipeline] Bucket ${i + 1}: "${name}" (${tempBucket.files.length} files)`);

            const bucket = await prisma.bucket.create({
                data: { jobId, name, centroid: [] },
            });

            await prisma.mediaFile.updateMany({
                where: { id: { in: tempBucket.files.map(f => f.id) } },
                data: { bucketId: bucket.id },
            });
        }

        // Handle videos: put all in one bucket
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

        // ========== STAGE 3: ROUND-ROBIN RANKING ==========
        console.log(`\n[Pipeline] ═══ STAGE 3: ROUND-ROBIN RANKING ═══`);
        await prisma.job.update({ where: { id: jobId }, data: { status: 'ranking', processedFiles: 0 } });

        const buckets = await prisma.bucket.findMany({
            where: { jobId },
            include: { mediaFiles: true },
        });

        await updateProgress('ranking', 0, buckets.length, 'Starting');

        for (let b = 0; b < buckets.length; b++) {
            const bucket = buckets[b];
            const files = bucket.mediaFiles.filter(f => f.mediaType === 'image');

            console.log(`\n[Pipeline] Ranking bucket "${bucket.name}" (${files.length} images)`);

            // Skip buckets with 0 or 1 image
            if (files.length < 2) {
                console.log(`    Skipping (${files.length} image${files.length === 1 ? ' - unique, no ranking needed' : 's'})`);
                await updateProgress('ranking', b + 1, buckets.length, bucket.name);
                continue;
            }

            // Initialize ELO scores
            const eloScores = new Map<string, number>();
            files.forEach(f => eloScores.set(f.id, ELO_INITIAL_SCORE));

            // Generate all match pairs
            const matches: { file1: typeof files[0]; file2: typeof files[0] }[] = [];
            for (let i = 0; i < files.length; i++) {
                for (let j = i + 1; j < files.length; j++) {
                    matches.push({ file1: files[i], file2: files[j] });
                }
            }

            console.log(`    Running ${matches.length} comparisons...`);

            // Run matches with limited concurrency
            let matchesCompleted = 0;
            await Promise.all(
                matches.map(({ file1, file2 }) =>
                    rankLimit(async () => {
                        try {
                            const buffer1 = filesWithData.find(f => f.id === file1.id)?.buffer || await downloadFromS3(file1.s3Key);
                            const buffer2 = filesWithData.find(f => f.id === file2.id)?.buffer || await downloadFromS3(file2.s3Key);

                            const result = await compareImages(
                                buffer1, file1.mimeType, file1.label || '',
                                buffer2, file2.mimeType, file2.label || ''
                            );

                            const winner = result.winner === 1 ? file1 : file2;
                            const loser = result.winner === 1 ? file2 : file1;

                            // Update ELO
                            const winnerElo = eloScores.get(winner.id) || ELO_INITIAL_SCORE;
                            const loserElo = eloScores.get(loser.id) || ELO_INITIAL_SCORE;
                            const K = ELO_K_FACTOR * result.confidence;
                            const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
                            const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));

                            eloScores.set(winner.id, winnerElo + K * (1 - expectedWinner));
                            eloScores.set(loser.id, loserElo + K * (0 - expectedLoser));

                            // Record match
                            await prisma.tournamentMatch.create({
                                data: {
                                    bucketId: bucket.id,
                                    mediaType: 'image',
                                    round: 1,
                                    media1Id: file1.id,
                                    media2Id: file2.id,
                                    winnerId: winner.id,
                                    reasoning: result.reasoning,
                                    media1EloChange: result.winner === 1 ? 16 : -16,
                                    media2EloChange: result.winner === 2 ? 16 : -16,
                                },
                            });

                            matchesCompleted++;
                            if (matchesCompleted % 5 === 0 || matchesCompleted === matches.length) {
                                console.log(`    Progress: ${matchesCompleted}/${matches.length}`);
                            }
                        } catch (error) {
                            console.error(`    Match error:`, error);
                            matchesCompleted++;
                        }
                    })
                )
            );

            // Save ELO scores
            await Promise.all(
                Array.from(eloScores.entries()).map(([id, score]) =>
                    prisma.mediaFile.update({ where: { id }, data: { eloScore: score } })
                )
            );

            // Mark top 3 as top picks
            const sorted = [...eloScores.entries()].sort((a, b) => b[1] - a[1]);
            const top3 = sorted.slice(0, 3);
            for (const [id] of top3) {
                await prisma.mediaFile.update({ where: { id }, data: { isTopPick: true } });
            }

            console.log(`    Top 3: ${top3.map(([id, elo]) => `${files.find(f => f.id === id)?.filename} (${elo.toFixed(0)})`).join(', ')}`);

            await updateProgress('ranking', b + 1, buckets.length, bucket.name);
        }

        // ========== STAGE 4: ENHANCEMENT ==========
        console.log(`\n[Pipeline] ═══ STAGE 4: ENHANCEMENT ═══`);
        await prisma.job.update({ where: { id: jobId }, data: { status: 'enhancing', processedFiles: 0 } });
        await updateProgress('enhancing', 0, 1, 'Starting image enhancement');

        const { enhanceTopImages } = await import('./enhancer');
        const enhancementResults = await enhanceTopImages(jobId, 3);
        console.log(`[Pipeline] Enhanced ${enhancementResults.length} images`);
        await updateProgress('enhancing', 1, 1, `Enhanced ${enhancementResults.length} images`);

        // ========== COMPLETE ==========
        console.log(`\n[Pipeline] ═══ COMPLETE ═══`);
        await prisma.job.update({
            where: { id: jobId },
            data: { status: 'completed', completedAt: new Date() },
        });

        await updateProgress('complete', 1, 1, 'Job completed');
        console.log(`[Pipeline] Job ${jobId} completed successfully\n`);

    } catch (error) {
        console.error(`[Pipeline] Error:`, error);
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

export { processJob as default };
