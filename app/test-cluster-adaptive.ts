#!/usr/bin/env npx tsx
/**
 * Adaptive Hierarchical Clustering Test
 * 
 * Usage: npm run test:cluster-adaptive -- /path/to/your/images.zip
 * 
 * This script uses an adaptive approach:
 * 1. Automatically finds optimal threshold using silhouette score
 * 2. Hierarchically splits clusters that are too diverse
 * 3. Creates sub-buckets for large clusters with internal variance
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
} from './src/lib/gemini';
import { cosineSimilarity } from './src/lib/processing/clustering';
import {
    SUPPORTED_IMAGE_EXTENSIONS,
    SUPPORTED_VIDEO_EXTENSIONS,
    PROCESSING_CONCURRENCY
} from './src/lib/types';

const limit = pLimit(PROCESSING_CONCURRENCY);

// Configuration
const MIN_CLUSTER_SIZE = 2;           // Minimum images per cluster
const MAX_CLUSTER_SIZE = 15;          // Split clusters larger than this
const MIN_INTRA_SIMILARITY = 0.80;    // Split if avg similarity below this
const THRESHOLD_SEARCH_STEPS = 20;    // How many thresholds to try

interface MediaFile {
    path: string;
    filename: string;
    mediaType: 'image' | 'video';
    mimeType: string;
    label?: string;
    embedding?: number[];
}

interface Cluster {
    id: string;
    name: string;
    files: MediaFile[];
    indices: number[];
    avgSimilarity: number;
    minSimilarity: number;
    parentId?: string;
}

// ========== UTILITY FUNCTIONS ==========

function getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() || '';
    const mimeTypes: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
        heif: 'image/heif', bmp: 'image/bmp', tiff: 'image/tiff',
        mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
        mkv: 'video/x-matroska', webm: 'video/webm', m4v: 'video/x-m4v',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

function shouldSkipFile(filename: string): boolean {
    const base = filename.split('/').pop() || filename;
    if (base.startsWith('._') || base.startsWith('.')) return true;
    if (filename.includes('__MACOSX')) return true;
    if (base.toLowerCase() === 'thumbs.db') return true;
    return false;
}

function getMediaType(filename: string): 'image' | 'video' | null {
    if (shouldSkipFile(filename)) return null;
    const ext = '.' + (filename.toLowerCase().split('.').pop() || '');
    if (SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) return 'image';
    if (SUPPORTED_VIDEO_EXTENSIONS.includes(ext)) return 'video';
    return null;
}

function getAllFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.') || entry === '__MACOSX') continue;
        const fullPath = join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
            files.push(...getAllFiles(fullPath));
        } else {
            files.push(fullPath);
        }
    }
    return files;
}

function sanitizeDirectoryName(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').slice(0, 50);
}

// ========== SIMILARITY FUNCTIONS ==========

function buildSimilarityMatrix(embeddings: number[][]): number[][] {
    const n = embeddings.length;
    const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        matrix[i][i] = 1.0;
        for (let j = i + 1; j < n; j++) {
            const sim = cosineSimilarity(embeddings[i], embeddings[j]);
            matrix[i][j] = sim;
            matrix[j][i] = sim;
        }
    }
    return matrix;
}

function getClusterStats(indices: number[], simMatrix: number[][]): { avg: number; min: number } {
    if (indices.length < 2) return { avg: 1.0, min: 1.0 };
    let sum = 0, count = 0, min = 1.0;
    for (let i = 0; i < indices.length; i++) {
        for (let j = i + 1; j < indices.length; j++) {
            const sim = simMatrix[indices[i]][indices[j]];
            sum += sim;
            min = Math.min(min, sim);
            count++;
        }
    }
    return { avg: count > 0 ? sum / count : 1.0, min };
}

// ========== CLUSTERING ALGORITHMS ==========

/**
 * Union-Find clustering at a specific threshold
 */
function clusterAtThreshold(simMatrix: number[][], threshold: number): number[] {
    const n = simMatrix.length;
    const parent: number[] = Array.from({ length: n }, (_, i) => i);

    function find(x: number): number {
        if (parent[x] !== x) parent[x] = find(parent[x]);
        return parent[x];
    }

    function union(x: number, y: number): void {
        const px = find(x), py = find(y);
        if (px !== py) parent[px] = py;
    }

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (simMatrix[i][j] >= threshold) union(i, j);
        }
    }

    const clusterMap = new Map<number, number>();
    const assignments: number[] = [];
    let nextId = 0;

    for (let i = 0; i < n; i++) {
        const root = find(i);
        if (!clusterMap.has(root)) clusterMap.set(root, nextId++);
        assignments.push(clusterMap.get(root)!);
    }

    return assignments;
}

/**
 * Calculate silhouette score for a clustering
 * Higher is better (range -1 to 1)
 */
function calculateSilhouetteScore(simMatrix: number[][], assignments: number[]): number {
    const n = simMatrix.length;
    const numClusters = Math.max(...assignments) + 1;

    if (numClusters === 1 || numClusters === n) return -1; // Edge cases

    let totalScore = 0;

    for (let i = 0; i < n; i++) {
        const myCluster = assignments[i];

        // Calculate a(i) = average dissimilarity to own cluster
        let ownSum = 0, ownCount = 0;
        for (let j = 0; j < n; j++) {
            if (i !== j && assignments[j] === myCluster) {
                ownSum += (1 - simMatrix[i][j]); // Convert similarity to dissimilarity
                ownCount++;
            }
        }
        const a = ownCount > 0 ? ownSum / ownCount : 0;

        // Calculate b(i) = minimum average dissimilarity to other clusters
        let minOtherAvg = Infinity;
        for (let c = 0; c < numClusters; c++) {
            if (c === myCluster) continue;
            let otherSum = 0, otherCount = 0;
            for (let j = 0; j < n; j++) {
                if (assignments[j] === c) {
                    otherSum += (1 - simMatrix[i][j]);
                    otherCount++;
                }
            }
            if (otherCount > 0) {
                minOtherAvg = Math.min(minOtherAvg, otherSum / otherCount);
            }
        }
        const b = minOtherAvg === Infinity ? 0 : minOtherAvg;

        // Silhouette for this point
        const s = Math.max(a, b) > 0 ? (b - a) / Math.max(a, b) : 0;
        totalScore += s;
    }

    return totalScore / n;
}

/**
 * Find optimal threshold using silhouette score
 */
function findOptimalThreshold(simMatrix: number[][]): { threshold: number; score: number; numClusters: number } {
    let bestThreshold = 0.8;
    let bestScore = -1;
    let bestNumClusters = 1;

    // Get similarity range
    let minSim = 1, maxSim = 0;
    for (let i = 0; i < simMatrix.length; i++) {
        for (let j = i + 1; j < simMatrix.length; j++) {
            minSim = Math.min(minSim, simMatrix[i][j]);
            maxSim = Math.max(maxSim, simMatrix[i][j]);
        }
    }

    const step = (maxSim - minSim) / THRESHOLD_SEARCH_STEPS;

    console.log(`   Searching for optimal threshold between ${minSim.toFixed(3)} and ${maxSim.toFixed(3)}...`);

    for (let t = minSim + step; t <= maxSim - step; t += step) {
        const assignments = clusterAtThreshold(simMatrix, t);
        const numClusters = Math.max(...assignments) + 1;

        // Skip if too few or too many clusters
        if (numClusters < 2 || numClusters >= simMatrix.length * 0.7) continue;

        const score = calculateSilhouetteScore(simMatrix, assignments);

        if (score > bestScore) {
            bestScore = score;
            bestThreshold = t;
            bestNumClusters = numClusters;
        }
    }

    console.log(`   Best threshold: ${bestThreshold.toFixed(3)} (silhouette: ${bestScore.toFixed(3)}, ${bestNumClusters} clusters)`);

    return { threshold: bestThreshold, score: bestScore, numClusters: bestNumClusters };
}

/**
 * Recursively split a cluster if it's too large or diverse
 */
function splitClusterIfNeeded(
    cluster: Cluster,
    allFiles: MediaFile[],
    simMatrix: number[][],
    depth: number = 0
): Cluster[] {
    const { indices, avgSimilarity } = cluster;

    // Base cases: don't split
    if (indices.length <= MIN_CLUSTER_SIZE) return [cluster];
    if (indices.length <= MAX_CLUSTER_SIZE && avgSimilarity >= MIN_INTRA_SIMILARITY) return [cluster];
    if (depth > 3) return [cluster]; // Prevent infinite recursion

    console.log(`   🔀 Splitting cluster "${cluster.name}" (${indices.length} images, avg sim: ${avgSimilarity.toFixed(3)})`);

    // Build sub-matrix for this cluster
    const subMatrix: number[][] = indices.map(i =>
        indices.map(j => simMatrix[i][j])
    );

    // Find optimal threshold for splitting this cluster
    const { threshold } = findOptimalThreshold(subMatrix);

    // Use a slightly higher threshold to actually split
    const splitThreshold = Math.min(threshold + 0.02, 0.98);
    const subAssignments = clusterAtThreshold(subMatrix, splitThreshold);
    const numSubClusters = Math.max(...subAssignments) + 1;

    if (numSubClusters <= 1) {
        // Can't split further
        return [cluster];
    }

    // Create sub-clusters
    const subClusters: Cluster[] = [];

    for (let c = 0; c < numSubClusters; c++) {
        const subIndices = subAssignments
            .map((assignment, idx) => assignment === c ? indices[idx] : -1)
            .filter(idx => idx !== -1);

        if (subIndices.length === 0) continue;

        const stats = getClusterStats(subIndices, simMatrix);
        const subCluster: Cluster = {
            id: `${cluster.id}.${c + 1}`,
            name: `${cluster.name} (${c + 1})`,
            files: subIndices.map(i => allFiles[i]),
            indices: subIndices,
            avgSimilarity: stats.avg,
            minSimilarity: stats.min,
            parentId: cluster.id,
        };

        // Recursively check if this sub-cluster needs splitting
        subClusters.push(...splitClusterIfNeeded(subCluster, allFiles, simMatrix, depth + 1));
    }

    return subClusters;
}

// ========== MAIN ==========

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: npm run test:cluster-adaptive -- /path/to/images.zip');
        process.exit(1);
    }

    const inputPath = args[0];

    if (!existsSync(inputPath)) {
        console.error(`Error: Path not found: ${inputPath}`);
        process.exit(1);
    }

    if (!process.env.GEMINI_API_KEY) {
        console.error('Error: GEMINI_API_KEY environment variable is required');
        process.exit(1);
    }

    console.log('🚀 PAL Adaptive Hierarchical Clustering\n');
    console.log(`Input: ${inputPath}\n`);

    let extractDir: string;
    let outputBaseDir: string;

    if (inputPath.endsWith('.zip')) {
        const zipDir = dirname(inputPath);
        const zipName = basename(inputPath, '.zip');
        extractDir = join(zipDir, `${zipName}_extracted`);
        outputBaseDir = join(zipDir, `${zipName}_adaptive_clustered`);
        mkdirSync(extractDir, { recursive: true });
        console.log(`📦 Extracting to: ${extractDir}\n`);
        new AdmZip(inputPath).extractAllTo(extractDir, true);
    } else {
        extractDir = inputPath;
        outputBaseDir = join(dirname(inputPath), `${basename(inputPath)}_adaptive_clustered`);
    }

    // Find media files
    const allFiles = getAllFiles(extractDir);
    const mediaFiles: MediaFile[] = allFiles
        .filter(f => getMediaType(f))
        .map(f => ({
            path: f,
            filename: basename(f),
            mediaType: getMediaType(f)!,
            mimeType: getMimeType(basename(f)),
        }));

    const imageFiles = mediaFiles.filter(f => f.mediaType === 'image');
    console.log(`📸 Found ${imageFiles.length} images\n`);

    if (imageFiles.length < 2) {
        console.error('Need at least 2 images');
        process.exit(1);
    }

    // Stage 1: Labeling
    console.log('🏷️  Stage 1: Labeling images...\n');
    await Promise.all(imageFiles.map((file, i) =>
        limit(async () => {
            try {
                const buffer = readFileSync(file.path);
                file.label = await generateImageLabel(buffer, file.mimeType);
                console.log(`   [${i + 1}/${imageFiles.length}] ${file.filename}`);
            } catch (e) {
                console.error(`   ❌ ${file.filename}:`, e);
                file.label = 'Image';
            }
        })
    ));

    // Stage 2: Embeddings
    console.log('\n📊 Stage 2: Generating embeddings...\n');
    await Promise.all(imageFiles.map((file, i) =>
        limit(async () => {
            if (!file.label) return;
            try {
                file.embedding = await generateEmbedding(file.label);
                console.log(`   [${i + 1}/${imageFiles.length}] ${file.filename} ✓`);
            } catch (e) {
                console.error(`   ❌ ${file.filename}:`, e);
            }
        })
    ));

    const filesWithEmbeddings = imageFiles.filter(f => f.embedding?.length);
    const embeddings = filesWithEmbeddings.map(f => f.embedding!);

    // Stage 3: Build similarity matrix
    console.log('\n🔗 Stage 3: Building similarity matrix...\n');
    const simMatrix = buildSimilarityMatrix(embeddings);

    // Stage 4: Find optimal initial clustering
    console.log('🎯 Stage 4: Finding optimal clustering...\n');
    const { threshold, numClusters } = findOptimalThreshold(simMatrix);
    const initialAssignments = clusterAtThreshold(simMatrix, threshold);

    // Build initial clusters
    const clusterGroups = new Map<number, number[]>();
    initialAssignments.forEach((c, i) => {
        if (!clusterGroups.has(c)) clusterGroups.set(c, []);
        clusterGroups.get(c)!.push(i);
    });

    let clusters: Cluster[] = [];
    let clusterCounter = 0;

    for (const [_, indices] of clusterGroups) {
        const stats = getClusterStats(indices, simMatrix);
        const labels = indices.map(i => filesWithEmbeddings[i].label || '').filter(Boolean);

        let name = `Cluster_${++clusterCounter}`;
        try {
            if (labels.length > 0) name = await generateClusterName(labels);
        } catch { }

        clusters.push({
            id: String(clusterCounter),
            name,
            files: indices.map(i => filesWithEmbeddings[i]),
            indices,
            avgSimilarity: stats.avg,
            minSimilarity: stats.min,
        });
    }

    // Stage 5: Hierarchical splitting
    console.log('\n🌳 Stage 5: Hierarchical refinement...\n');
    const refinedClusters: Cluster[] = [];

    for (const cluster of clusters) {
        const splitResult = splitClusterIfNeeded(cluster, filesWithEmbeddings, simMatrix);
        refinedClusters.push(...splitResult);
    }

    // Generate better names for sub-clusters
    console.log('\n📝 Generating cluster names...\n');
    for (const cluster of refinedClusters) {
        if (cluster.parentId) {
            const labels = cluster.files.map(f => f.label || '').filter(Boolean);
            try {
                cluster.name = await generateClusterName(labels);
            } catch { }
        }
    }

    // Sort by size
    refinedClusters.sort((a, b) => b.files.length - a.files.length);

    // Stage 6: Organize files
    console.log('📁 Stage 6: Organizing files...\n');
    mkdirSync(outputBaseDir, { recursive: true });

    // Save report
    const report = {
        totalImages: filesWithEmbeddings.length,
        initialClusters: numClusters,
        finalClusters: refinedClusters.length,
        optimalThreshold: threshold,
        clusters: refinedClusters.map(c => ({
            name: c.name,
            count: c.files.length,
            avgSimilarity: c.avgSimilarity,
            files: c.files.map(f => f.filename),
        })),
    };
    writeFileSync(join(outputBaseDir, 'clustering_report.json'), JSON.stringify(report, null, 2));

    for (const cluster of refinedClusters) {
        const dirName = sanitizeDirectoryName(cluster.name);
        const clusterDir = join(outputBaseDir, dirName);
        mkdirSync(clusterDir, { recursive: true });

        console.log(`   📂 ${dirName}/ (${cluster.files.length} images, sim: ${cluster.avgSimilarity.toFixed(3)})`);

        for (const file of cluster.files) {
            copyFileSync(file.path, join(clusterDir, file.filename));
        }
    }

    // Results
    console.log('\n' + '='.repeat(65));
    console.log('📋 ADAPTIVE CLUSTERING RESULTS');
    console.log('='.repeat(65));
    console.log(`\n📂 Output: ${outputBaseDir}`);
    console.log(`🎯 Optimal threshold: ${threshold.toFixed(3)}`);
    console.log(`📊 Initial clusters: ${numClusters} → Final: ${refinedClusters.length}\n`);

    console.log('┌' + '─'.repeat(35) + '┬' + '─'.repeat(7) + '┬' + '─'.repeat(10) + '┬' + '─'.repeat(9) + '┐');
    console.log('│ Cluster                           │ Count │ Avg Sim  │ Min Sim │');
    console.log('├' + '─'.repeat(35) + '┼' + '─'.repeat(7) + '┼' + '─'.repeat(10) + '┼' + '─'.repeat(9) + '┤');

    for (const c of refinedClusters) {
        const name = c.name.slice(0, 33).padEnd(33);
        const count = String(c.files.length).padStart(5);
        const avg = c.avgSimilarity.toFixed(3).padStart(8);
        const min = c.minSimilarity.toFixed(3).padStart(7);
        console.log(`│ ${name} │ ${count} │ ${avg} │ ${min} │`);
    }

    console.log('└' + '─'.repeat(35) + '┴' + '─'.repeat(7) + '┴' + '─'.repeat(10) + '┴' + '─'.repeat(9) + '┘\n');
    console.log(`✅ Complete! Check ${outputBaseDir}\n`);
}

main().catch(console.error);
