#!/usr/bin/env npx tsx
/**
 * Semantic Vision Clustering Test
 * 
 * Usage: npm run test:cluster-semantic -- /path/to/your/images.zip
 * 
 * This script uses Gemini's vision model to directly compare images
 * semantically (visually), rather than comparing text embeddings.
 * 
 * Note: This is O(n²) in API calls, so it's slower but more accurate.
 */

import 'dotenv/config';
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import AdmZip from 'adm-zip';
import pLimit from 'p-limit';

import {
    generateImageLabel,
    compareImagesSemantically,
    generateClusterName
} from '../src/lib/gemini';
import {
    SUPPORTED_IMAGE_EXTENSIONS,
    SUPPORTED_VIDEO_EXTENSIONS,
} from '../src/lib/types';

// Lower concurrency for vision API to avoid rate limits
const limit = pLimit(3);

// Configuration
const MIN_CLUSTER_SIZE = 2;
const MAX_CLUSTER_SIZE = 12;
const MIN_INTRA_SIMILARITY = 0.65;
const SILHOUETTE_THRESHOLD_STEPS = 15;

interface MediaFile {
    path: string;
    filename: string;
    mediaType: 'image' | 'video';
    mimeType: string;
    buffer?: Buffer;
    label?: string;
}

interface Cluster {
    id: string;
    name: string;
    files: MediaFile[];
    indices: number[];
    avgSimilarity: number;
    minSimilarity: number;
}

// ========== UTILITY FUNCTIONS ==========

function getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() || '';
    const mimeTypes: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
        heif: 'image/heif', bmp: 'image/bmp', tiff: 'image/tiff',
    };
    return mimeTypes[ext] || 'image/jpeg';
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

// ========== CLUSTERING FUNCTIONS ==========

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

function calculateSilhouetteScore(simMatrix: number[][], assignments: number[]): number {
    const n = simMatrix.length;
    const numClusters = Math.max(...assignments) + 1;

    if (numClusters === 1 || numClusters >= n * 0.8) return -1;

    let totalScore = 0;

    for (let i = 0; i < n; i++) {
        const myCluster = assignments[i];

        let ownSum = 0, ownCount = 0;
        for (let j = 0; j < n; j++) {
            if (i !== j && assignments[j] === myCluster) {
                ownSum += (1 - simMatrix[i][j]);
                ownCount++;
            }
        }
        const a = ownCount > 0 ? ownSum / ownCount : 0;

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

        const s = Math.max(a, b) > 0 ? (b - a) / Math.max(a, b) : 0;
        totalScore += s;
    }

    return totalScore / n;
}

function findOptimalThreshold(simMatrix: number[][]): { threshold: number; score: number; numClusters: number } {
    let best = { threshold: 0.6, score: -1, numClusters: 1 };

    let minSim = 1, maxSim = 0;
    for (let i = 0; i < simMatrix.length; i++) {
        for (let j = i + 1; j < simMatrix.length; j++) {
            minSim = Math.min(minSim, simMatrix[i][j]);
            maxSim = Math.max(maxSim, simMatrix[i][j]);
        }
    }

    const step = (maxSim - minSim) / SILHOUETTE_THRESHOLD_STEPS;

    for (let t = minSim + step; t <= maxSim - step; t += step) {
        const assignments = clusterAtThreshold(simMatrix, t);
        const numClusters = Math.max(...assignments) + 1;

        if (numClusters < 2 || numClusters >= simMatrix.length * 0.7) continue;

        const score = calculateSilhouetteScore(simMatrix, assignments);

        if (score > best.score) {
            best = { threshold: t, score, numClusters };
        }
    }

    return best;
}

function splitClusterIfNeeded(
    cluster: Cluster,
    allFiles: MediaFile[],
    simMatrix: number[][],
    depth: number = 0
): Cluster[] {
    const { indices, avgSimilarity } = cluster;

    if (indices.length <= MIN_CLUSTER_SIZE) return [cluster];
    if (indices.length <= MAX_CLUSTER_SIZE && avgSimilarity >= MIN_INTRA_SIMILARITY) return [cluster];
    if (depth > 2) return [cluster];

    console.log(`   🔀 Splitting "${cluster.name}" (${indices.length} images, sim: ${avgSimilarity.toFixed(2)})`);

    const subMatrix: number[][] = indices.map(i => indices.map(j => simMatrix[i][j]));
    const { threshold } = findOptimalThreshold(subMatrix);
    const splitThreshold = Math.min(threshold + 0.03, 0.95);
    const subAssignments = clusterAtThreshold(subMatrix, splitThreshold);
    const numSubClusters = Math.max(...subAssignments) + 1;

    if (numSubClusters <= 1) return [cluster];

    const subClusters: Cluster[] = [];

    for (let c = 0; c < numSubClusters; c++) {
        const subIndices = subAssignments
            .map((a, idx) => a === c ? indices[idx] : -1)
            .filter(idx => idx !== -1);

        if (subIndices.length === 0) continue;

        const stats = getClusterStats(subIndices, simMatrix);
        subClusters.push(...splitClusterIfNeeded({
            id: `${cluster.id}.${c + 1}`,
            name: `${cluster.name} (${c + 1})`,
            files: subIndices.map(i => allFiles[i]),
            indices: subIndices,
            avgSimilarity: stats.avg,
            minSimilarity: stats.min,
        }, allFiles, simMatrix, depth + 1));
    }

    return subClusters;
}

// ========== MAIN ==========

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: npm run test:cluster-semantic -- /path/to/images.zip');
        process.exit(1);
    }

    const inputPath = args[0];

    if (!existsSync(inputPath)) {
        console.error(`Error: Path not found: ${inputPath}`);
        process.exit(1);
    }

    if (!process.env.GEMINI_API_KEY) {
        console.error('Error: GEMINI_API_KEY required');
        process.exit(1);
    }

    console.log('🚀 PAL Semantic Vision Clustering\n');
    console.log(`Input: ${inputPath}`);
    console.log('⚠️  Note: This uses O(n²) vision API calls for direct image comparison\n');

    let extractDir: string;
    let outputBaseDir: string;

    if (inputPath.endsWith('.zip')) {
        const zipDir = dirname(inputPath);
        const zipName = basename(inputPath, '.zip');
        extractDir = join(zipDir, `${zipName}_extracted`);
        outputBaseDir = join(zipDir, `${zipName}_semantic_clustered`);
        mkdirSync(extractDir, { recursive: true });
        console.log(`📦 Extracting to: ${extractDir}\n`);
        new AdmZip(inputPath).extractAllTo(extractDir, true);
    } else {
        extractDir = inputPath;
        outputBaseDir = join(dirname(inputPath), `${basename(inputPath)}_semantic_clustered`);
    }

    // Find image files
    const allFiles = getAllFiles(extractDir);
    const imageFiles: MediaFile[] = allFiles
        .filter(f => getMediaType(f) === 'image')
        .map(f => ({
            path: f,
            filename: basename(f),
            mediaType: 'image' as const,
            mimeType: getMimeType(basename(f)),
        }));

    console.log(`📸 Found ${imageFiles.length} images\n`);

    if (imageFiles.length < 2) {
        console.error('Need at least 2 images');
        process.exit(1);
    }

    // Load all image buffers
    console.log('📥 Loading image buffers...\n');
    for (const file of imageFiles) {
        file.buffer = readFileSync(file.path);
    }

    // Stage 1: Generate labels for naming (lightweight)
    console.log('🏷️  Stage 1: Generating labels for naming...\n');
    await Promise.all(imageFiles.map((file, i) =>
        limit(async () => {
            try {
                file.label = await generateImageLabel(file.buffer!, file.mimeType);
                console.log(`   [${i + 1}/${imageFiles.length}] ${file.filename}`);
            } catch {
                file.label = file.filename;
            }
        })
    ));

    // Stage 2: Semantic pairwise comparison
    console.log('\n🔍 Stage 2: Semantic pairwise comparison using Gemini Vision...\n');

    const n = imageFiles.length;
    const totalPairs = (n * (n - 1)) / 2;
    const simMatrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

    // Initialize diagonal
    for (let i = 0; i < n; i++) simMatrix[i][i] = 1.0;

    // Build all pairs
    const pairs: { i: number; j: number }[] = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            pairs.push({ i, j });
        }
    }

    console.log(`   Comparing ${totalPairs} image pairs...\n`);

    let completed = 0;
    await Promise.all(pairs.map(({ i, j }) =>
        limit(async () => {
            try {
                const result = await compareImagesSemantically(
                    imageFiles[i].buffer!,
                    imageFiles[i].mimeType,
                    imageFiles[j].buffer!,
                    imageFiles[j].mimeType
                );
                simMatrix[i][j] = result.similarity;
                simMatrix[j][i] = result.similarity;
            } catch (e) {
                console.error(`   ❌ Failed: ${imageFiles[i].filename} vs ${imageFiles[j].filename}`);
                simMatrix[i][j] = 0.5;
                simMatrix[j][i] = 0.5;
            }

            completed++;
            if (completed % 10 === 0 || completed === totalPairs) {
                const pct = Math.round((completed / totalPairs) * 100);
                console.log(`   Progress: ${completed}/${totalPairs} (${pct}%)`);
            }
        })
    ));

    // Show stats
    let minSim = 1, maxSim = 0, sumSim = 0;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            minSim = Math.min(minSim, simMatrix[i][j]);
            maxSim = Math.max(maxSim, simMatrix[i][j]);
            sumSim += simMatrix[i][j];
        }
    }
    console.log(`\n   Similarity range: ${minSim.toFixed(2)} - ${maxSim.toFixed(2)} (avg: ${(sumSim / totalPairs).toFixed(2)})`);

    // Stage 3: Optimal clustering
    console.log('\n🎯 Stage 3: Finding optimal clustering...\n');
    const { threshold, numClusters } = findOptimalThreshold(simMatrix);
    console.log(`   Optimal threshold: ${threshold.toFixed(3)} → ${numClusters} initial clusters`);

    const initialAssignments = clusterAtThreshold(simMatrix, threshold);

    // Build initial clusters
    const clusterGroups = new Map<number, number[]>();
    initialAssignments.forEach((c, i) => {
        if (!clusterGroups.has(c)) clusterGroups.set(c, []);
        clusterGroups.get(c)!.push(i);
    });

    let clusters: Cluster[] = [];
    let counter = 0;

    for (const [_, indices] of clusterGroups) {
        const stats = getClusterStats(indices, simMatrix);
        const labels = indices.map(i => imageFiles[i].label || '').filter(Boolean);

        let name = `Cluster_${++counter}`;
        try {
            if (labels.length > 0) name = await generateClusterName(labels);
        } catch { }

        clusters.push({
            id: String(counter),
            name,
            files: indices.map(i => imageFiles[i]),
            indices,
            avgSimilarity: stats.avg,
            minSimilarity: stats.min,
        });
    }

    // Stage 4: Hierarchical refinement
    console.log('\n🌳 Stage 4: Hierarchical refinement...\n');
    const refined: Cluster[] = [];
    for (const cluster of clusters) {
        refined.push(...splitClusterIfNeeded(cluster, imageFiles, simMatrix));
    }

    // Generate names for sub-clusters
    for (const c of refined) {
        if (c.id.includes('.')) {
            const labels = c.files.map(f => f.label || '').filter(Boolean);
            try {
                c.name = await generateClusterName(labels);
            } catch { }
        }
    }

    refined.sort((a, b) => b.files.length - a.files.length);

    // Stage 5: Organize
    console.log('\n📁 Stage 5: Organizing files...\n');
    mkdirSync(outputBaseDir, { recursive: true });

    // Save similarity matrix
    let csv = ',' + imageFiles.map(f => f.filename).join(',') + '\n';
    for (let i = 0; i < n; i++) {
        csv += imageFiles[i].filename + ',' + simMatrix[i].map(s => s.toFixed(3)).join(',') + '\n';
    }
    writeFileSync(join(outputBaseDir, 'semantic_similarity_matrix.csv'), csv);

    // Save report
    const report = {
        method: 'Gemini Vision Semantic Comparison',
        totalImages: n,
        totalComparisons: totalPairs,
        optimalThreshold: threshold,
        initialClusters: numClusters,
        finalClusters: refined.length,
        clusters: refined.map(c => ({
            name: c.name,
            count: c.files.length,
            avgSimilarity: c.avgSimilarity,
            minSimilarity: c.minSimilarity,
            files: c.files.map(f => f.filename),
        })),
    };
    writeFileSync(join(outputBaseDir, 'clustering_report.json'), JSON.stringify(report, null, 2));

    for (const cluster of refined) {
        const dirName = sanitizeDirectoryName(cluster.name);
        const clusterDir = join(outputBaseDir, dirName);
        mkdirSync(clusterDir, { recursive: true });

        console.log(`   📂 ${dirName}/ (${cluster.files.length}, sim: ${cluster.avgSimilarity.toFixed(2)})`);

        for (const file of cluster.files) {
            copyFileSync(file.path, join(clusterDir, file.filename));
        }
    }

    // Results
    console.log('\n' + '='.repeat(70));
    console.log('📋 SEMANTIC CLUSTERING RESULTS');
    console.log('='.repeat(70));
    console.log(`\n📂 Output: ${outputBaseDir}`);
    console.log(`🔍 Method: Direct Gemini Vision comparison (${totalPairs} comparisons)`);
    console.log(`🎯 Optimal threshold: ${threshold.toFixed(3)}`);
    console.log(`📊 Clusters: ${numClusters} initial → ${refined.length} final\n`);

    console.log('┌' + '─'.repeat(38) + '┬' + '─'.repeat(7) + '┬' + '─'.repeat(10) + '┬' + '─'.repeat(10) + '┐');
    console.log('│ Cluster                              │ Count │ Avg Sim  │ Min Sim  │');
    console.log('├' + '─'.repeat(38) + '┼' + '─'.repeat(7) + '┼' + '─'.repeat(10) + '┼' + '─'.repeat(10) + '┤');

    for (const c of refined) {
        const name = c.name.slice(0, 36).padEnd(36);
        const count = String(c.files.length).padStart(5);
        const avg = c.avgSimilarity.toFixed(3).padStart(8);
        const min = c.minSimilarity.toFixed(3).padStart(8);
        console.log(`│ ${name} │ ${count} │ ${avg} │ ${min} │`);
    }

    console.log('└' + '─'.repeat(38) + '┴' + '─'.repeat(7) + '┴' + '─'.repeat(10) + '┴' + '─'.repeat(10) + '┘\n');
    console.log(`✅ Complete! Check ${outputBaseDir}\n`);
}

main().catch(console.error);
