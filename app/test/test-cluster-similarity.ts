#!/usr/bin/env npx tsx
/**
 * Test script for clustering using pairwise similarity comparison
 * 
 * Usage: npm run test:cluster-similarity -- /path/to/your/images.zip
 * 
 * This script uses a graph-based clustering approach:
 * 1. Compares every image to every other image using cosine similarity
 * 2. Builds a similarity graph where edges exist above a threshold
 * 3. Uses connected components to form clusters
 * 4. Copies images into categorized directories
 */

import 'dotenv/config';
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import AdmZip from 'adm-zip';
import pLimit from 'p-limit';

import {
    generateImageLabel,
    generateEmbedding,
    generateClusterName
} from '../src/lib/gemini';
import { cosineSimilarity } from '../src/lib/processing/clustering';
import {
    SUPPORTED_IMAGE_EXTENSIONS,
    SUPPORTED_VIDEO_EXTENSIONS,
    PROCESSING_CONCURRENCY
} from '../src/lib/types';

// Concurrency limiter
const limit = pLimit(PROCESSING_CONCURRENCY);

// Similarity threshold for considering images as "similar"
const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

interface MediaFile {
    path: string;
    filename: string;
    mediaType: 'image' | 'video';
    mimeType: string;
    label?: string;
    embedding?: number[];
    clusterId?: number;
}

interface SimilarityEdge {
    i: number;
    j: number;
    similarity: number;
}

interface ClusterResult {
    name: string;
    files: MediaFile[];
    avgSimilarity: number;
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
 * Check if file should be skipped
 */
function shouldSkipFile(filename: string): boolean {
    const base = filename.split('/').pop() || filename;
    if (base.startsWith('._')) return true;
    if (base.startsWith('.')) return true;
    if (filename.includes('__MACOSX')) return true;
    if (base.toLowerCase() === 'thumbs.db') return true;
    return false;
}

/**
 * Determine if file is image or video
 */
function getMediaType(filename: string): 'image' | 'video' | null {
    if (shouldSkipFile(filename)) return null;
    const ext = '.' + (filename.toLowerCase().split('.').pop() || '');
    if (SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) return 'image';
    if (SUPPORTED_VIDEO_EXTENSIONS.includes(ext)) return 'video';
    return null;
}

/**
 * Recursively get all files in a directory
 */
function getAllFiles(dir: string): string[] {
    const files: string[] = [];
    const entries = readdirSync(dir);
    for (const entry of entries) {
        if (entry.startsWith('.') || entry === '__MACOSX') continue;
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

/**
 * Sanitize cluster name for directory
 */
function sanitizeDirectoryName(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 50);
}

/**
 * Build similarity matrix between all embeddings
 */
function buildSimilarityMatrix(embeddings: number[][]): number[][] {
    const n = embeddings.length;
    const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

    for (let i = 0; i < n; i++) {
        matrix[i][i] = 1.0; // Self-similarity is 1
        for (let j = i + 1; j < n; j++) {
            const sim = cosineSimilarity(embeddings[i], embeddings[j]);
            matrix[i][j] = sim;
            matrix[j][i] = sim;
        }
    }

    return matrix;
}

/**
 * Find connected components using Union-Find with similarity threshold
 */
function findClusters(
    similarityMatrix: number[][],
    threshold: number
): number[] {
    const n = similarityMatrix.length;
    const parent: number[] = Array.from({ length: n }, (_, i) => i);
    const rank: number[] = Array(n).fill(0);

    // Find with path compression
    function find(x: number): number {
        if (parent[x] !== x) {
            parent[x] = find(parent[x]);
        }
        return parent[x];
    }

    // Union by rank
    function union(x: number, y: number): void {
        const px = find(x);
        const py = find(y);
        if (px === py) return;

        if (rank[px] < rank[py]) {
            parent[px] = py;
        } else if (rank[px] > rank[py]) {
            parent[py] = px;
        } else {
            parent[py] = px;
            rank[px]++;
        }
    }

    // Connect nodes with similarity above threshold
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (similarityMatrix[i][j] >= threshold) {
                union(i, j);
            }
        }
    }

    // Normalize cluster IDs
    const clusterMap = new Map<number, number>();
    const assignments: number[] = [];
    let nextClusterId = 0;

    for (let i = 0; i < n; i++) {
        const root = find(i);
        if (!clusterMap.has(root)) {
            clusterMap.set(root, nextClusterId++);
        }
        assignments.push(clusterMap.get(root)!);
    }

    return assignments;
}

/**
 * Calculate average intra-cluster similarity
 */
function calculateClusterSimilarity(
    indices: number[],
    similarityMatrix: number[][]
): number {
    if (indices.length < 2) return 1.0;

    let sum = 0;
    let count = 0;

    for (let i = 0; i < indices.length; i++) {
        for (let j = i + 1; j < indices.length; j++) {
            sum += similarityMatrix[indices[i]][indices[j]];
            count++;
        }
    }

    return count > 0 ? sum / count : 1.0;
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: npm run test:cluster-similarity -- /path/to/images.zip [threshold]');
        console.error('       threshold: similarity threshold (0-1), default 0.75');
        process.exit(1);
    }

    const inputPath = args[0];
    const threshold = args[1] ? parseFloat(args[1]) : DEFAULT_SIMILARITY_THRESHOLD;

    if (!existsSync(inputPath)) {
        console.error(`Error: Path not found: ${inputPath}`);
        process.exit(1);
    }

    if (!process.env.GEMINI_API_KEY) {
        console.error('Error: GEMINI_API_KEY environment variable is required');
        process.exit(1);
    }

    console.log('🚀 PAL Similarity-Based Clustering Test\n');
    console.log(`Input: ${inputPath}`);
    console.log(`Similarity threshold: ${threshold}\n`);

    let extractDir: string;
    let outputBaseDir: string;

    if (inputPath.endsWith('.zip')) {
        const zipDir = dirname(inputPath);
        const zipName = basename(inputPath, '.zip');
        extractDir = join(zipDir, `${zipName}_extracted`);
        outputBaseDir = join(zipDir, `${zipName}_similarity_clustered`);

        mkdirSync(extractDir, { recursive: true });
        console.log(`📦 Extracting zip to: ${extractDir}\n`);

        const zip = new AdmZip(inputPath);
        zip.extractAllTo(extractDir, true);
    } else {
        extractDir = inputPath;
        outputBaseDir = join(dirname(inputPath), `${basename(inputPath)}_similarity_clustered`);
    }

    // Find all media files
    const allFiles = getAllFiles(extractDir);
    const mediaFiles: MediaFile[] = [];

    for (const filePath of allFiles) {
        const filename = basename(filePath);
        const mediaType = getMediaType(filePath);
        if (mediaType) {
            mediaFiles.push({
                path: filePath,
                filename,
                mediaType,
                mimeType: getMimeType(filename),
            });
        }
    }

    const imageFiles = mediaFiles.filter(f => f.mediaType === 'image');

    console.log(`📸 Found ${imageFiles.length} images\n`);

    if (imageFiles.length < 2) {
        console.error('Need at least 2 images for similarity clustering');
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
            } catch (error) {
                console.error(`   ❌ Error labeling ${file.filename}:`, error);
                file.label = 'Image requiring manual review';
            }
        })
    );

    await Promise.all(labelingTasks);

    // ========== STAGE 2: EMBEDDING ==========
    console.log('\n📊 Stage 2: Generating embeddings...\n');

    const embeddingTasks = imageFiles.map((file, index) =>
        limit(async () => {
            if (!file.label) return;
            try {
                file.embedding = await generateEmbedding(file.label);
                console.log(`   [${index + 1}/${imageFiles.length}] ${file.filename} ✓`);
            } catch (error) {
                console.error(`   ❌ Error embedding ${file.filename}:`, error);
            }
        })
    );

    await Promise.all(embeddingTasks);

    // ========== STAGE 3: PAIRWISE SIMILARITY ==========
    console.log('\n🔗 Stage 3: Computing pairwise similarities...\n');

    const filesWithEmbeddings = imageFiles.filter(f => f.embedding && f.embedding.length > 0);
    const embeddings = filesWithEmbeddings.map(f => f.embedding!);

    console.log(`   Computing ${embeddings.length * (embeddings.length - 1) / 2} pairwise comparisons...`);

    const similarityMatrix = buildSimilarityMatrix(embeddings);

    // Show similarity stats
    let minSim = 1, maxSim = 0, sumSim = 0, countSim = 0;
    for (let i = 0; i < embeddings.length; i++) {
        for (let j = i + 1; j < embeddings.length; j++) {
            const sim = similarityMatrix[i][j];
            minSim = Math.min(minSim, sim);
            maxSim = Math.max(maxSim, sim);
            sumSim += sim;
            countSim++;
        }
    }

    console.log(`   Min similarity: ${minSim.toFixed(3)}`);
    console.log(`   Max similarity: ${maxSim.toFixed(3)}`);
    console.log(`   Avg similarity: ${(sumSim / countSim).toFixed(3)}`);

    // ========== STAGE 4: CLUSTERING ==========
    console.log('\n🧩 Stage 4: Clustering with threshold...\n');

    const assignments = findClusters(similarityMatrix, threshold);
    const numClusters = Math.max(...assignments) + 1;

    console.log(`   Found ${numClusters} clusters with threshold ${threshold}`);

    // Assign cluster IDs to files
    filesWithEmbeddings.forEach((file, i) => {
        file.clusterId = assignments[i];
    });

    // Build cluster results
    const clusterMap = new Map<number, MediaFile[]>();
    filesWithEmbeddings.forEach(file => {
        const id = file.clusterId!;
        if (!clusterMap.has(id)) clusterMap.set(id, []);
        clusterMap.get(id)!.push(file);
    });

    const clusters: ClusterResult[] = [];

    for (const [clusterId, files] of clusterMap) {
        const labels = files.map(f => f.label || '').filter(Boolean);
        const indices = files.map(f => filesWithEmbeddings.indexOf(f));
        const avgSim = calculateClusterSimilarity(indices, similarityMatrix);

        let name = `Cluster_${clusterId + 1}`;
        if (labels.length > 0) {
            try {
                name = await generateClusterName(labels);
            } catch {
                // Use default
            }
        }

        clusters.push({ name, files, avgSimilarity: avgSim });
    }

    // Sort clusters by size
    clusters.sort((a, b) => b.files.length - a.files.length);

    // ========== STAGE 5: ORGANIZE INTO DIRECTORIES ==========
    console.log('\n📁 Stage 5: Organizing images into directories...\n');

    mkdirSync(outputBaseDir, { recursive: true });

    // Save similarity matrix as CSV for analysis
    const csvPath = join(outputBaseDir, 'similarity_matrix.csv');
    let csv = 'filename,' + filesWithEmbeddings.map(f => f.filename).join(',') + '\n';
    for (let i = 0; i < filesWithEmbeddings.length; i++) {
        csv += filesWithEmbeddings[i].filename + ',';
        csv += similarityMatrix[i].map(s => s.toFixed(3)).join(',') + '\n';
    }
    writeFileSync(csvPath, csv);
    console.log(`   📊 Saved similarity matrix to: similarity_matrix.csv`);

    for (const cluster of clusters) {
        const clusterDirName = sanitizeDirectoryName(cluster.name);
        const clusterDir = join(outputBaseDir, clusterDirName);
        mkdirSync(clusterDir, { recursive: true });

        console.log(`   📂 ${clusterDirName}/ (avg similarity: ${cluster.avgSimilarity.toFixed(3)})`);

        for (const file of cluster.files) {
            const destPath = join(clusterDir, file.filename);
            copyFileSync(file.path, destPath);
            console.log(`      └─ ${file.filename}`);
        }
    }

    // ========== RESULTS ==========
    console.log('\n' + '='.repeat(60));
    console.log('📋 SIMILARITY CLUSTERING RESULTS');
    console.log('='.repeat(60) + '\n');

    console.log(`📂 Output directory: ${outputBaseDir}`);
    console.log(`🎯 Similarity threshold: ${threshold}\n`);

    for (const cluster of clusters) {
        console.log(`\n🗂️  ${cluster.name} (${cluster.files.length} images, avg sim: ${cluster.avgSimilarity.toFixed(3)})`);
        console.log('   ' + '-'.repeat(50));

        for (const file of cluster.files) {
            console.log(`   • ${file.filename}`);
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`✅ Complete: ${clusters.length} clusters from ${filesWithEmbeddings.length} images`);
    console.log('='.repeat(60) + '\n');

    // Summary table
    console.log('📊 Summary:');
    console.log('┌' + '─'.repeat(32) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(10) + '┐');
    console.log('│ Cluster                        │ Count  │ Avg Sim  │');
    console.log('├' + '─'.repeat(32) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(10) + '┤');

    for (const cluster of clusters) {
        const name = cluster.name.slice(0, 30).padEnd(30);
        const count = String(cluster.files.length).padStart(6);
        const sim = cluster.avgSimilarity.toFixed(3).padStart(8);
        console.log(`│ ${name} │ ${count} │ ${sim} │`);
    }

    console.log('└' + '─'.repeat(32) + '┴' + '─'.repeat(8) + '┴' + '─'.repeat(10) + '┘\n');
}

main().catch(console.error);
