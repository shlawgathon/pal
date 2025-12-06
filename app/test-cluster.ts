#!/usr/bin/env npx tsx
/**
 * Test script for clustering a local zip file
 * 
 * Usage: npm run test:cluster -- /path/to/your/images.zip
 * 
 * This script:
 * 1. Extracts a zip file to a temp directory
 * 2. Labels images using Gemini
 * 3. Generates embeddings
 * 4. Clusters similar images
 * 5. Outputs results to console
 */

import 'dotenv/config';
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';
import pLimit from 'p-limit';

import {
    generateImageLabel,
    generateEmbedding,
    generateClusterName
} from './src/lib/gemini';
import {
    kMeansClustering,
    findOptimalK
} from './src/lib/processing/clustering';
import {
    SUPPORTED_IMAGE_EXTENSIONS,
    SUPPORTED_VIDEO_EXTENSIONS,
    PROCESSING_CONCURRENCY
} from './src/lib/types';

// Concurrency limiter
const limit = pLimit(PROCESSING_CONCURRENCY);

interface MediaFile {
    path: string;
    filename: string;
    mediaType: 'image' | 'video';
    mimeType: string;
    label?: string;
    embedding?: number[];
}

interface ClusterResult {
    name: string;
    files: MediaFile[];
}

/**
 * Get MIME type from extension
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
 * Determine if file is image or video
 */
function getMediaType(filename: string): 'image' | 'video' | null {
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
 * Recursively get all files in a directory
 */
function getAllFiles(dir: string): string[] {
    const files: string[] = [];

    const entries = readdirSync(dir);
    for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
            files.push(...getAllFiles(fullPath));
        } else {
            files.push(fullPath);
        }
    }

    return files;
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: npm run test:cluster -- /path/to/images.zip');
        console.error('       npm run test:cluster -- /path/to/images/directory');
        process.exit(1);
    }

    const inputPath = args[0];

    if (!existsSync(inputPath)) {
        console.error(`Error: Path not found: ${inputPath}`);
        process.exit(1);
    }

    // Check for Gemini API key
    if (!process.env.GEMINI_API_KEY) {
        console.error('Error: GEMINI_API_KEY environment variable is required');
        console.error('Set it in your .env file or export it');
        process.exit(1);
    }

    console.log('🚀 PAL Clustering Test\n');
    console.log(`Input: ${inputPath}`);

    let extractDir: string;

    // Check if input is a zip file or directory
    if (inputPath.endsWith('.zip')) {
        // Extract zip to temp directory
        extractDir = join(tmpdir(), `pal-test-${Date.now()}`);
        mkdirSync(extractDir, { recursive: true });

        console.log(`📦 Extracting zip to: ${extractDir}\n`);

        const zip = new AdmZip(inputPath);
        zip.extractAllTo(extractDir, true);
    } else {
        extractDir = inputPath;
    }

    // Find all media files
    const allFiles = getAllFiles(extractDir);
    const mediaFiles: MediaFile[] = [];

    for (const filePath of allFiles) {
        const filename = basename(filePath);
        const mediaType = getMediaType(filename);

        if (mediaType) {
            mediaFiles.push({
                path: filePath,
                filename,
                mediaType,
                mimeType: getMimeType(filename),
            });
        }
    }

    console.log(`📸 Found ${mediaFiles.length} media files`);
    console.log(`   Images: ${mediaFiles.filter(f => f.mediaType === 'image').length}`);
    console.log(`   Videos: ${mediaFiles.filter(f => f.mediaType === 'video').length}\n`);

    if (mediaFiles.length === 0) {
        console.error('No supported media files found');
        process.exit(1);
    }

    // Only process images for clustering (videos have separate tournament)
    const imageFiles = mediaFiles.filter(f => f.mediaType === 'image');

    if (imageFiles.length === 0) {
        console.error('No image files found for clustering');
        process.exit(1);
    }

    // ========== STAGE 1: LABELING ==========
    console.log('🏷️  Stage 1: Labeling images with Gemini...\n');

    const labelingTasks = imageFiles.map((file, index) =>
        limit(async () => {
            try {
                const buffer = readFileSync(file.path);
                const label = await generateImageLabel(buffer, file.mimeType);
                file.label = label;
                console.log(`   [${index + 1}/${imageFiles.length}] ${file.filename}`);
                console.log(`      → ${label.slice(0, 80)}${label.length > 80 ? '...' : ''}`);
                return file;
            } catch (error) {
                console.error(`   ❌ Error labeling ${file.filename}:`, error);
                file.label = 'Image requiring manual review';
                return file;
            }
        })
    );

    await Promise.all(labelingTasks);

    // ========== STAGE 2: EMBEDDING ==========
    console.log('\n📊 Stage 2: Generating embeddings...\n');

    const embeddingTasks = imageFiles.map((file, index) =>
        limit(async () => {
            if (!file.label) return file;

            try {
                const embedding = await generateEmbedding(file.label);
                file.embedding = embedding;
                console.log(`   [${index + 1}/${imageFiles.length}] ${file.filename} ✓`);
                return file;
            } catch (error) {
                console.error(`   ❌ Error embedding ${file.filename}:`, error);
                return file;
            }
        })
    );

    await Promise.all(embeddingTasks);

    // ========== STAGE 3: CLUSTERING ==========
    console.log('\n🔗 Stage 3: Clustering similar images...\n');

    const filesWithEmbeddings = imageFiles.filter(f => f.embedding && f.embedding.length > 0);

    if (filesWithEmbeddings.length < 2) {
        console.log('Not enough images with embeddings for clustering');
        console.log('\nResults: All images in single cluster');
        process.exit(0);
    }

    const embeddings = filesWithEmbeddings.map(f => f.embedding!);

    // Find optimal k
    const maxK = Math.min(10, Math.floor(filesWithEmbeddings.length / 2));
    const optimalK = findOptimalK(embeddings, maxK);
    console.log(`   Optimal number of clusters: ${optimalK}`);

    // Run clustering
    const clusterResult = kMeansClustering(embeddings, Math.max(1, optimalK));

    // Build cluster results
    const clusters: ClusterResult[] = [];

    for (const cluster of clusterResult.clusters) {
        const clusterFiles = cluster.memberIndices.map(i => filesWithEmbeddings[i]);
        const labels = clusterFiles.map(f => f.label || '').filter(Boolean);

        // Generate cluster name
        let name = `Cluster ${cluster.clusterIndex + 1}`;
        if (labels.length > 0) {
            try {
                name = await generateClusterName(labels);
            } catch {
                // Use default name
            }
        }

        clusters.push({
            name,
            files: clusterFiles,
        });
    }

    // ========== RESULTS ==========
    console.log('\n' + '='.repeat(60));
    console.log('📋 CLUSTERING RESULTS');
    console.log('='.repeat(60) + '\n');

    for (const cluster of clusters) {
        console.log(`\n🗂️  ${cluster.name} (${cluster.files.length} images)`);
        console.log('   ' + '-'.repeat(50));

        for (const file of cluster.files) {
            console.log(`   • ${file.filename}`);
            if (file.label) {
                console.log(`     "${file.label.slice(0, 60)}${file.label.length > 60 ? '...' : ''}"`);
            }
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`✅ Clustering complete: ${clusters.length} clusters from ${filesWithEmbeddings.length} images`);
    console.log('='.repeat(60) + '\n');

    // Summary table
    console.log('\n📊 Summary:');
    console.log('┌' + '─'.repeat(30) + '┬' + '─'.repeat(10) + '┐');
    console.log('│ Cluster                      │ Count    │');
    console.log('├' + '─'.repeat(30) + '┼' + '─'.repeat(10) + '┤');

    for (const cluster of clusters) {
        const name = cluster.name.slice(0, 28).padEnd(28);
        const count = String(cluster.files.length).padStart(8);
        console.log(`│ ${name} │ ${count} │`);
    }

    console.log('└' + '─'.repeat(30) + '┴' + '─'.repeat(10) + '┘\n');
}

main().catch(console.error);
