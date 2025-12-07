import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { IMAGE_COMPARISON_CRITERIA, VIDEO_COMPARISON_CRITERIA } from './types';

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Models
const visionModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
const textModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });

/**
 * Generate a descriptive label for an image
 */
export async function generateImageLabel(imageBuffer: Buffer, mimeType: string): Promise<string> {
    const imagePart = {
        inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType,
        },
    };

    const prompt = `You are a professional photography expert. Describe this photograph in a single, detailed sentence that captures:
- The main subject(s)
- The setting/environment
- The mood/atmosphere
- Notable photographic qualities (lighting, composition, style)

Respond with ONLY the descriptive sentence, nothing else.`;

    const result = await visionModel.generateContent([prompt, imagePart]);
    const response = await result.response;
    return response.text().trim();
}

/**
 * Generate a descriptive label for a video (using first frame)
 */
export async function generateVideoLabel(videoBuffer: Buffer, mimeType: string): Promise<string> {
    // For videos, we'll use the video directly if supported, or describe based on metadata
    const videoPart = {
        inlineData: {
            data: videoBuffer.toString('base64'),
            mimeType,
        },
    };

    const prompt = `You are a professional videographer expert. Describe this video clip in a single, detailed sentence that captures:
- The main subject(s) and action
- The setting/environment
- The mood/atmosphere
- Notable cinematographic qualities (camera work, lighting, style)

Respond with ONLY the descriptive sentence, nothing else.`;

    try {
        const result = await visionModel.generateContent([prompt, videoPart]);
        const response = await result.response;
        return response.text().trim();
    } catch {
        // Fallback if video not supported
        return 'Video content requiring manual review';
    }
}

/**
 * Generate text embedding for clustering
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    const result = await embeddingModel.embedContent(text);
    return result.embedding.values;
}

/**
 * Compare two images semantically using Gemini vision
 * Returns a similarity score from 0.0 to 1.0
 */
export async function compareImagesSemantically(
    image1Buffer: Buffer,
    image1MimeType: string,
    image2Buffer: Buffer,
    image2MimeType: string
): Promise<{ similarity: number; reasoning: string }> {
    const image1Part = {
        inlineData: {
            data: image1Buffer.toString('base64'),
            mimeType: image1MimeType,
        },
    };

    const image2Part = {
        inlineData: {
            data: image2Buffer.toString('base64'),
            mimeType: image2MimeType,
        },
    };

    const prompt = `You are an expert at visual similarity analysis. Compare these two images and rate how similar they are.

Consider:
- Subject matter (what's in the image)
- Scene/setting/environment
- Style and composition
- Color palette and mood
- Overall visual appearance

Rate their similarity from 0.0 to 1.0 where:
- 0.0-0.2: Completely different subjects/scenes
- 0.3-0.4: Same general category but different subjects
- 0.5-0.6: Similar subjects in different contexts
- 0.7-0.8: Very similar subjects and scenes
- 0.9-1.0: Nearly identical or same shot from different angle

Respond in this exact JSON format:
{
  "similarity": 0.0 to 1.0,
  "reasoning": "Brief explanation of similarity"
}

Respond with ONLY the JSON, no markdown.`;

    try {
        const result = await visionModel.generateContent([prompt, image1Part, image2Part]);
        const response = await result.response;
        const text = response.text().trim();

        const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
        return {
            similarity: Math.min(1, Math.max(0, parsed.similarity || 0.5)),
            reasoning: parsed.reasoning || '',
        };
    } catch {
        return { similarity: 0.5, reasoning: 'Comparison failed' };
    }
}

/**
 * Compare two images and determine winner for tournament
 */
export async function compareImages(
    image1Buffer: Buffer,
    image1MimeType: string,
    image1Label: string,
    image2Buffer: Buffer,
    image2MimeType: string,
    image2Label: string
): Promise<{ winner: 1 | 2; reasoning: string; confidence: number }> {
    const image1Part = {
        inlineData: {
            data: image1Buffer.toString('base64'),
            mimeType: image1MimeType,
        },
    };

    const image2Part = {
        inlineData: {
            data: image2Buffer.toString('base64'),
            mimeType: image2MimeType,
        },
    };

    const prompt = `${IMAGE_COMPARISON_CRITERIA}

IMAGE 1 Description: "${image1Label}"
IMAGE 2 Description: "${image2Label}"

Compare these two photographs and determine which one is the better professional photograph.

Respond in this exact JSON format:
{
  "winner": 1 or 2,
  "reasoning": "Brief explanation of why this image is better",
  "confidence": 0.0 to 1.0
}

Respond with ONLY the JSON, no markdown formatting or extra text.`;

    const result = await visionModel.generateContent([prompt, image1Part, image2Part]);
    const response = await result.response;
    const text = response.text().trim();

    try {
        const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
        return {
            winner: parsed.winner === 1 ? 1 : 2,
            reasoning: parsed.reasoning || 'No reasoning provided',
            confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
        };
    } catch {
        // Default fallback
        return { winner: 1, reasoning: 'Comparison parsing failed', confidence: 0.5 };
    }
}

/**
 * Compare two videos and determine winner for tournament
 */
export async function compareVideos(
    video1Buffer: Buffer,
    video1MimeType: string,
    video1Label: string,
    video2Buffer: Buffer,
    video2MimeType: string,
    video2Label: string
): Promise<{ winner: 1 | 2; reasoning: string; confidence: number }> {
    const video1Part = {
        inlineData: {
            data: video1Buffer.toString('base64'),
            mimeType: video1MimeType,
        },
    };

    const video2Part = {
        inlineData: {
            data: video2Buffer.toString('base64'),
            mimeType: video2MimeType,
        },
    };

    const prompt = `${VIDEO_COMPARISON_CRITERIA}

VIDEO 1 Description: "${video1Label}"
VIDEO 2 Description: "${video2Label}"

Compare these two video clips and determine which one is the better professional footage.

Respond in this exact JSON format:
{
  "winner": 1 or 2,
  "reasoning": "Brief explanation of why this video is better",
  "confidence": 0.0 to 1.0
}

Respond with ONLY the JSON, no markdown formatting or extra text.`;

    try {
        const result = await visionModel.generateContent([prompt, video1Part, video2Part]);
        const response = await result.response;
        const text = response.text().trim();

        const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
        return {
            winner: parsed.winner === 1 ? 1 : 2,
            reasoning: parsed.reasoning || 'No reasoning provided',
            confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
        };
    } catch {
        // Default fallback for video comparison
        return { winner: 1, reasoning: 'Video comparison not available', confidence: 0.5 };
    }
}

/**
 * Enhance an image using Gemini's image generation capabilities
 * Note: This uses the vision model to suggest enhancements, actual editing
 * would require an image editing API
 */
export async function analyzeImageForEnhancement(
    imageBuffer: Buffer,
    mimeType: string
): Promise<{
    suggestions: string[];
    enhancedDescription: string;
}> {
    const imagePart = {
        inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType,
        },
    };

    const prompt = `You are an expert photo editor. Analyze this photograph and provide:

1. Specific enhancement suggestions (exposure, color grading, sharpening, etc.)
2. A description of how the image would look after professional enhancement

Respond in this exact JSON format:
{
  "suggestions": ["suggestion 1", "suggestion 2", ...],
  "enhancedDescription": "Description of the enhanced result"
}

Respond with ONLY the JSON, no markdown formatting.`;

    const result = await visionModel.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text().trim();

    try {
        const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
        return {
            suggestions: parsed.suggestions || [],
            enhancedDescription: parsed.enhancedDescription || '',
        };
    } catch {
        return {
            suggestions: ['Auto-enhance exposure', 'Adjust color balance'],
            enhancedDescription: 'Professionally enhanced photograph',
        };
    }
}

/**
 * Generate a cluster name based on representative images
 */
export async function generateClusterName(labels: string[]): Promise<string> {
    const prompt = `Based on these image descriptions, generate a short, descriptive name (2-4 words) for this group of similar photographs:

${labels.slice(0, 5).map((l, i) => `${i + 1}. ${l}`).join('\n')}

Respond with ONLY the group name, nothing else. Examples: "Urban Street Portraits", "Golden Hour Landscapes", "Action Sports Shots"`;

    const result = await textModel.generateContent(prompt);
    const response = await result.response;
    return response.text().trim().replace(/['"]/g, '');
}

export { genAI, visionModel, textModel, embeddingModel };
