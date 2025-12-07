/**
 * Image enhancement post-processor using Gemini native image generation
 */

import { GoogleGenAI } from '@google/genai';
import prisma from '../prisma';
import { downloadFromS3, uploadToS3, generateS3Key } from '../s3';
import type { MediaFile } from '@prisma/client';

// Initialize the Gemini client for image generation
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export interface EnhancementResult {
    mediaFileId: string;
    enhancedS3Key: string;
    enhancedS3Url: string;
}

/**
 * Enhance an image using Gemini's native image generation capabilities
 */
async function enhanceImageWithGemini(
    imageBuffer: Buffer,
    mimeType: string
): Promise<Buffer | null> {
    const prompt = `You are a professional photo editor. Enhance this photograph with the following improvements:
- Optimize exposure and dynamic range
- Improve color vibrancy and white balance
- Enhance sharpness and clarity
- Reduce noise if present
- Improve overall aesthetic appeal

Make subtle, professional adjustments that enhance the photo without making it look over-processed.
Return only the enhanced image.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash-exp',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType,
                                data: imageBuffer.toString('base64'),
                            },
                        },
                    ],
                },
            ],
            config: {
                responseModalities: ['image', 'text'],
            },
        });

        // Extract the image from the response
        if (response.candidates && response.candidates[0]?.content?.parts) {
            for (const part of response.candidates[0].content.parts) {
                if (part.inlineData?.data) {
                    return Buffer.from(part.inlineData.data, 'base64');
                }
            }
        }

        console.warn('[Enhancer] No image returned from Gemini');
        return null;
    } catch (error) {
        console.error('[Enhancer] Gemini image generation failed:', error);
        return null;
    }
}

/**
 * Apply enhancement to an image and store the result
 */
export async function enhanceImage(mediaFile: MediaFile): Promise<EnhancementResult | null> {
    if (mediaFile.mediaType !== 'image') {
        return null; // Only enhance images
    }

    try {
        console.log(`[Enhancer] Enhancing ${mediaFile.filename}...`);

        // Download original image
        const imageBuffer = await downloadFromS3(mediaFile.s3Key);

        // Enhance with Gemini
        const enhancedBuffer = await enhanceImageWithGemini(imageBuffer, mediaFile.mimeType);

        if (!enhancedBuffer) {
            console.warn(`[Enhancer] Failed to enhance ${mediaFile.filename}, skipping`);
            return null;
        }

        // Generate S3 key for enhanced image
        const enhancedKey = generateS3Key(
            mediaFile.jobId,
            `enhanced_${mediaFile.filename}`,
            'enhanced'
        );

        // Upload enhanced image to S3
        const { s3Key, s3Url } = await uploadToS3(
            enhancedKey,
            enhancedBuffer,
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

        console.log(`[Enhancer] Successfully enhanced ${mediaFile.filename} -> ${s3Url}`);

        return {
            mediaFileId: mediaFile.id,
            enhancedS3Key: s3Key,
            enhancedS3Url: s3Url,
        };
    } catch (error) {
        console.error(`[Enhancer] Failed to enhance ${mediaFile.filename}:`, error);
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
    console.log(`[Enhancer] Starting enhancement for job ${jobId}, top ${topN} per bucket`);

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
        console.log(`[Enhancer] Processing bucket "${bucket.name}" (${bucket.mediaFiles.length} top picks)`);

        for (const mediaFile of bucket.mediaFiles) {
            const result = await enhanceImage(mediaFile);
            if (result) {
                results.push(result);
            }
        }
    }

    console.log(`[Enhancer] Enhancement complete: ${results.length} images enhanced`);
    return results;
}
