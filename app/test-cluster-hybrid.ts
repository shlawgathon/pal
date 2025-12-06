#!/usr/bin/env npx tsx
/**
 * Hybrid Two-Phase Clustering
 *
 * Usage: npm run test:cluster-hybrid -- /path/to/your/images.zip
 *
 * Phase 1: Fast rough clustering using text embeddings (cheap, O(n) API calls)
 * Phase 2: Semantic vision comparisons ONLY within each bucket (expensive, but limited scope)
 *
 * This dramatically reduces API calls while maintaining accuracy.
 * Example: 44 images in 4 buckets → ~220 comparisons instead of ~946
 */

import 'dotenv/config';
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import AdmZip from 'adm-zip';
import pLimit from 'p-limit';

import {
    generateImageLabel,
    generateEmbedding,
    compareImagesSemantically,
    generateClusterName
} from './src/lib/gemini';
import { cosineSimilarity } from './src/lib/processing/clustering';
import {
    SUPPORTED_IMAGE_EXTENSIONS,
    PROCESSING_CONCURRENCY
} from './src/lib/types';

// Concurrency limits
const embeddingLimit = pLimit(PROCESSING_CONCURRENCY); // Fast, can parallelize
const visionLimit = pLimit(3); // Slower, rate-limited

// Configuration
const ROUGH_CLUSTER_THRESHOLD = 0.90;  // Loose threshold for initial grouping

interface MediaFile {
    path: string;
    filename: string;
    mimeType: string;
    buffer?: Buffer;
    label?: string;
    embedding?: number[];
}

interface Bucket {
    id: string;
    name: string;
    files: MediaFile[];
    indices: number[];
    avgSimilarity: number;
}

// ========== UTILITY FUNCTIONS ==========

function getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() || '';
    const mimeTypes: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
    };
    return mimeTypes[ext] || 'image/jpeg';
}

function shouldSkipFile(filename: string): boolean {
    const base = filename.split('/').pop() || filename;
    return base.startsWith('._') || base.startsWith('.') ||
        filename.includes('__MACOSX') || base.toLowerCase() === 'thumbs.db';
}

function getMediaType(filename: string): 'image' | null {
    if (shouldSkipFile(filename)) return null;
    const ext = '.' + (filename.toLowerCase().split('.').pop() || '');
    return SUPPORTED_IMAGE_EXTENSIONS.includes(ext) ? 'image' : null;
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

// ========== PHASE 1: EMBEDDING-BASED ROUGH CLUSTERING ==========

function roughClusterByEmbedding(
    embeddings: number[][],
    threshold: number
): number[] {
    const n = embeddings.length;
    const parent: number[] = Array.from({ length: n }, (_, i) => i);

    function find(x: number): number {
        if (parent[x] !== x) parent[x] = find(parent[x]);
        return parent[x];
    }

    function union(x: number, y: number): void {
        const px = find(x), py = find(y);
        if (px !== py) parent[px] = py;
    }

    // Connect images with similar embeddings
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const sim = cosineSimilarity(embeddings[i], embeddings[j]);
            if (sim >= threshold) union(i, j);
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

// ========== PHASE 2: SEMANTIC REFINEMENT WITHIN BUCKETS ==========

async function buildSemanticMatrixForBucket(
    files: MediaFile[],
    progressCallback?: (done: number, total: number) => void
): Promise<number[][]> {
    const n = files.length;
    const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

    // Diagonal = 1
    for (let i = 0; i < n; i++) matrix[i][i] = 1.0;

    if (n < 2) return matrix;

    // Build pairs
    const pairs: { i: number; j: number }[] = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            pairs.push({ i, j });
        }
    }

    let completed = 0;

    await Promise.all(pairs.map(({ i, j }) =>
        visionLimit(async () => {
            try {
                const result = await compareImagesSemantically(
                    files[i].buffer!,
                    files[i].mimeType,
                    files[j].buffer!,
                    files[j].mimeType
                );
                matrix[i][j] = result.similarity;
                matrix[j][i] = result.similarity;
            } catch {
                matrix[i][j] = 0.5;
                matrix[j][i] = 0.5;
            }
            completed++;
            progressCallback?.(completed, pairs.length);
        })
    ));

    return matrix;
}

function refineBucketWithSemantic(
    simMatrix: number[][],
    threshold: number
): number[] {
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

function getOptimalThreshold(simMatrix: number[][]): number {
    const n = simMatrix.length;
    if (n < 2) return 0.7;

    // Collect all similarities
    const sims: number[] = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            sims.push(simMatrix[i][j]);
        }
    }

    sims.sort((a, b) => a - b);

    // Use median as threshold (adaptive)
    const median = sims[Math.floor(sims.length / 2)];

    // But don't go too low or too high
    return Math.max(0.55, Math.min(0.85, median + 0.05));
}

function getBucketStats(indices: number[], simMatrix: number[][]): { avg: number; min: number } {
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

// ========== MAIN ==========

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: npm run test:cluster-hybrid -- /path/to/images.zip');
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

    console.log('🚀 PAL Hybrid Two-Phase Clustering\n');
    console.log(`Input: ${inputPath}`);
    console.log('📊 Phase 1: Fast embedding clustering (cheap)');
    console.log('🔍 Phase 2: Semantic vision refinement within buckets (accurate)\n');

    let extractDir: string;
    let outputBaseDir: string;

    if (inputPath.endsWith('.zip')) {
        const zipDir = dirname(inputPath);
        const zipName = basename(inputPath, '.zip');
        extractDir = join(zipDir, `${zipName}_extracted`);
        outputBaseDir = join(zipDir, `${zipName}_hybrid_clustered`);
        mkdirSync(extractDir, { recursive: true });
        console.log(`📦 Extracting to: ${extractDir}\n`);
        new AdmZip(inputPath).extractAllTo(extractDir, true);
    } else {
        extractDir = inputPath;
        outputBaseDir = join(dirname(inputPath), `${basename(inputPath)}_hybrid_clustered`);
    }

    // Find and load images
    const allFiles = getAllFiles(extractDir);
    const imageFiles: MediaFile[] = allFiles
        .filter(f => getMediaType(f) === 'image')
        .map(f => ({
            path: f,
            filename: basename(f),
            mimeType: getMimeType(basename(f)),
        }));

    console.log(`📸 Found ${imageFiles.length} images\n`);

    if (imageFiles.length < 2) {
        console.error('Need at least 2 images');
        process.exit(1);
    }

    // Load buffers
    for (const file of imageFiles) {
        file.buffer = readFileSync(file.path);
    }

    // ========== PHASE 1: LABELING & EMBEDDING ==========
    console.log('━'.repeat(60));
    console.log('📋 PHASE 1: Fast Embedding-Based Rough Clustering');
    console.log('━'.repeat(60) + '\n');

    console.log('🏷️  Generating labels...\n');
    await Promise.all(imageFiles.map((file, i) =>
        embeddingLimit(async () => {
            try {
                file.label = await generateImageLabel(file.buffer!, file.mimeType);
                console.log(`   [${i + 1}/${imageFiles.length}] ${file.filename}`);
            } catch {
                file.label = file.filename;
            }
        })
    ));

    console.log('\n📊 Generating embeddings...\n');
    await Promise.all(imageFiles.map((file, i) =>
        embeddingLimit(async () => {
            if (!file.label) return;
            try {
                file.embedding = await generateEmbedding(file.label);
                console.log(`   [${i + 1}/${imageFiles.length}] ${file.filename} ✓`);
            } catch {
                file.embedding = [];
            }
        })
    ));

    const filesWithEmbeddings = imageFiles.filter(f => f.embedding?.length);
    const embeddings = filesWithEmbeddings.map(f => f.embedding!);

    console.log('\n🔗 Rough clustering by embedding similarity...\n');
    const roughAssignments = roughClusterByEmbedding(embeddings, ROUGH_CLUSTER_THRESHOLD);
    const numRoughBuckets = Math.max(...roughAssignments) + 1;

    console.log(`   Found ${numRoughBuckets} rough buckets (threshold: ${ROUGH_CLUSTER_THRESHOLD})\n`);

    // Group into buckets
    const roughBuckets: Map<number, number[]> = new Map();
    roughAssignments.forEach((c, i) => {
        if (!roughBuckets.has(c)) roughBuckets.set(c, []);
        roughBuckets.get(c)!.push(i);
    });

    // ========== PHASE 2: SEMANTIC REFINEMENT ==========
    console.log('━'.repeat(60));
    console.log('🔍 PHASE 2: Semantic Vision Refinement Within Buckets');
    console.log('━'.repeat(60) + '\n');

    const finalBuckets: Bucket[] = [];
    let bucketCounter = 0;
    let totalComparisons = 0;

    for (const [roughId, indices] of roughBuckets) {
        const bucketFiles = indices.map(i => filesWithEmbeddings[i]);
        const n = bucketFiles.length;
        const pairsInBucket = (n * (n - 1)) / 2;
        totalComparisons += pairsInBucket;

        console.log(`\n📦 Processing rough bucket ${roughId + 1} (${n} images, ${pairsInBucket} comparisons)...`);

        if (n === 1) {
            // Single image bucket
            const labels = bucketFiles.map(f => f.label || '').filter(Boolean);
            let name = `Single_${++bucketCounter}`;
            try { name = await generateClusterName(labels); } catch { }

            finalBuckets.push({
                id: String(bucketCounter),
                name,
                files: bucketFiles,
                indices,
                avgSimilarity: 1.0,
            });
            continue;
        }

        // Build semantic similarity matrix for this bucket only
        const simMatrix = await buildSemanticMatrixForBucket(bucketFiles, (done, total) => {
            if (done % 5 === 0 || done === total) {
                console.log(`   Comparisons: ${done}/${total}`);
            }
        });

        // Find optimal threshold for this bucket
        const threshold = getOptimalThreshold(simMatrix);
        console.log(`   Optimal threshold: ${threshold.toFixed(2)}`);

        // Refine into sub-buckets
        const subAssignments = refineBucketWithSemantic(simMatrix, threshold);
        const numSubBuckets = Math.max(...subAssignments) + 1;

        console.log(`   Split into ${numSubBuckets} refined bucket(s)`);

        // Create final buckets
        for (let sub = 0; sub < numSubBuckets; sub++) {
            const subIndices = subAssignments
                .map((a, idx) => a === sub ? idx : -1)
                .filter(idx => idx !== -1);

            if (subIndices.length === 0) continue;

            const subFiles = subIndices.map(i => bucketFiles[i]);
            const globalIndices = subIndices.map(i => indices[i]);
            const stats = getBucketStats(subIndices, simMatrix);

            const labels = subFiles.map(f => f.label || '').filter(Boolean);
            let name = `Bucket_${++bucketCounter}`;
            try { name = await generateClusterName(labels); } catch { }

            finalBuckets.push({
                id: String(bucketCounter),
                name,
                files: subFiles,
                indices: globalIndices,
                avgSimilarity: stats.avg,
            });
        }
    }

    // Sort by size
    finalBuckets.sort((a, b) => b.files.length - a.files.length);

    // ========== ORGANIZE FILES ==========
    console.log('\n' + '━'.repeat(60));
    console.log('📁 Organizing files...');
    console.log('━'.repeat(60) + '\n');

    mkdirSync(outputBaseDir, { recursive: true });

    // Save report
    const fullPairwise = (imageFiles.length * (imageFiles.length - 1)) / 2;
    const report = {
        method: 'Hybrid Two-Phase Clustering',
        totalImages: imageFiles.length,
        roughBuckets: numRoughBuckets,
        finalBuckets: finalBuckets.length,
        comparisonsUsed: totalComparisons,
        comparisonsSaved: fullPairwise - totalComparisons,
        savingsPercent: Math.round((1 - totalComparisons / fullPairwise) * 100),
        buckets: finalBuckets.map(b => ({
            name: b.name,
            count: b.files.length,
            avgSimilarity: b.avgSimilarity,
            files: b.files.map(f => f.filename),
        })),
    };
    writeFileSync(join(outputBaseDir, 'clustering_report.json'), JSON.stringify(report, null, 2));

    for (const bucket of finalBuckets) {
        const dirName = sanitizeDirectoryName(bucket.name);
        const bucketDir = join(outputBaseDir, dirName);
        mkdirSync(bucketDir, { recursive: true });

        console.log(`   📂 ${dirName}/ (${bucket.files.length}, sim: ${bucket.avgSimilarity.toFixed(2)})`);

        for (const file of bucket.files) {
            copyFileSync(file.path, join(bucketDir, file.filename));
        }
    }

    // ========== RESULTS ==========
    console.log('\n' + '═'.repeat(70));
    console.log('📋 HYBRID CLUSTERING RESULTS');
    console.log('═'.repeat(70));

    console.log(`\n📂 Output: ${outputBaseDir}`);
    console.log(`\n📊 Efficiency:`);
    console.log(`   Full pairwise would need: ${fullPairwise} comparisons`);
    console.log(`   Hybrid approach used:     ${totalComparisons} comparisons`);
    console.log(`   💰 Saved: ${report.comparisonsSaved} comparisons (${report.savingsPercent}% reduction!)\n`);

    console.log('┌' + '─'.repeat(40) + '┬' + '─'.repeat(7) + '┬' + '─'.repeat(10) + '┐');
    console.log('│ Bucket                                 │ Count │ Avg Sim  │');
    console.log('├' + '─'.repeat(40) + '┼' + '─'.repeat(7) + '┼' + '─'.repeat(10) + '┤');

    for (const b of finalBuckets) {
        const name = b.name.slice(0, 38).padEnd(38);
        const count = String(b.files.length).padStart(5);
        const sim = b.avgSimilarity.toFixed(3).padStart(8);
        console.log(`│ ${name} │ ${count} │ ${sim} │`);
    }

    console.log('└' + '─'.repeat(40) + '┴' + '─'.repeat(7) + '┴' + '─'.repeat(10) + '┘\n');
    console.log(`✅ Complete! ${numRoughBuckets} rough → ${finalBuckets.length} refined buckets\n`);
}

main().catch(console.error);
