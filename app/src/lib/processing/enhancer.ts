/**
 * Image enhancement post-processor
 */

import prisma from '../prisma';
import { downloadFromS3, uploadToS3, generateS3Key } from '../s3';
import { analyzeImageForEnhancement } from '../gemini';
import type { MediaFile } from '@prisma/client';

export interface EnhancementResult {
    mediaFileId: string;
    enhancedS3Key: string;
    enhancedS3Url: string;
    suggestions: string[];
}

/**
 * Apply enhancement analysis to an image
 * Note: Actual image manipulation would require additional libraries
 * like Sharp. This implementation stores enhancement metadata.
 */
export async function enhanceImage(mediaFile: MediaFile): Promise<EnhancementResult | null> {
    if (mediaFile.mediaType !== 'image') {
        return null; // Only enhance images
    }

    try {
        // Download original image
        const imageBuffer = await downloadFromS3(mediaFile.s3Key);

        // Get enhancement suggestions from Gemini
        const { suggestions, enhancedDescription } = await analyzeImageForEnhancement(
            imageBuffer,
            mediaFile.mimeType
        );

        // For now, we store the original with enhancement metadata
        // In production, you'd use Sharp or similar to actually enhance
        const enhancedKey = generateS3Key(
            mediaFile.jobId,
            `enhanced_${mediaFile.filename}`,
            'enhanced'
        );

        // Upload (in production, this would be the actually enhanced image)
        const { s3Key, s3Url } = await uploadToS3(
            enhancedKey,
            imageBuffer,
            mediaFile.mimeType
        );

        // Update database record
        await prisma.mediaFile.update({
            where: { id: mediaFile.id },
            data: {
                enhancedS3Key: s3Key,
                enhancedS3Url: s3Url,
            },
        });

        console.log(`Enhanced ${mediaFile.filename}: ${suggestions.join(', ')}`);

        return {
            mediaFileId: mediaFile.id,
            enhancedS3Key: s3Key,
            enhancedS3Url: s3Url,
            suggestions,
        };
    } catch (error) {
        console.error(`Failed to enhance ${mediaFile.filename}:`, error);
        return null;
    }
}

/**
 * Enhance top images from all buckets in a job
 */
export async function enhanceTopImages(
    jobId: string,
    topN: number = 3
): Promise<EnhancementResult[]> {
    // Get all buckets for the job
    const buckets = await prisma.bucket.findMany({
        where: { jobId },
        include: {
            mediaFiles: {
                where: {
                    mediaType: 'image',
                    isTopPick: true,
                },
                orderBy: { eloScore: 'desc' },
                take: topN,
            },
        },
    });

    const results: EnhancementResult[] = [];

    for (const bucket of buckets) {
        for (const mediaFile of bucket.mediaFiles) {
            const result = await enhanceImage(mediaFile);
            if (result) {
                results.push(result);
            }
        }
    }

    return results;
}
