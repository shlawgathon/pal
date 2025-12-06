#!/usr/bin/env npx tsx
/**
 * Parallelized Hybrid Two-Phase Clustering
 *
 * Usage: npm run test:cluster-hybrid-parallel -- /path/to/your/images.zip
 *
 * Phase 1: Fast rough clustering using text embeddings (fully parallelized)
 * Phase 2: Semantic vision comparisons within buckets (parallelized per bucket)
 *
 * All stages run with maximum parallelization for speed.
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
} from '../src/lib/gemini';
import { cosineSimilarity } from '../src/lib/processing/clustering';
import { SUPPORTED_IMAGE_EXTENSIONS } from '../src/lib/types';

// Parallelization limits
const LABEL_CONCURRENCY = 10;    // Fast, can do many
const EMBEDDING_CONCURRENCY = 10;
const VISION_CONCURRENCY = 5;    // Slower, rate limited
const CLUSTER_NAME_CONCURRENCY = 5;

const labelLimit = pLimit(LABEL_CONCURRENCY);
const embeddingLimit = pLimit(EMBEDDING_CONCURRENCY);
const visionLimit = pLimit(VISION_CONCURRENCY);
const nameLimit = pLimit(CLUSTER_NAME_CONCURRENCY);

// Configuration
const ROUGH_CLUSTER_THRESHOLD = 0.90;

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

// ========== UTILITIES ==========

function getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() || '';
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic' }[ext] || 'image/jpeg';
}

function shouldSkipFile(filename: string): boolean {
    const base = filename.split('/').pop() || filename;
    return base.startsWith('._') || base.startsWith('.') || filename.includes('__MACOSX') || base.toLowerCase() === 'thumbs.db';
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
        if (statSync(fullPath).isDirectory()) files.push(...getAllFiles(fullPath));
        else files.push(fullPath);
    }
    return files;
}

function sanitizeDirName(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').slice(0, 50);
}

// ========== PHASE 1: EMBEDDING CLUSTERING ==========

function roughCluster(embeddings: number[][], threshold: number): number[] {
    const n = embeddings.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => parent[x] !== x ? (parent[x] = find(parent[x])) : x;
    const union = (x: number, y: number) => { parent[find(x)] = find(y); };

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (cosineSimilarity(embeddings[i], embeddings[j]) >= threshold) union(i, j);
        }
    }

    const map = new Map<number, number>();
    return Array.from({ length: n }, (_, i) => {
        const root = find(i);
        if (!map.has(root)) map.set(root, map.size);
        return map.get(root)!;
    });
}

// ========== PHASE 2: SEMANTIC REFINEMENT ==========

async function buildSemanticMatrix(files: MediaFile[]): Promise<number[][]> {
    const n = files.length;
    const matrix = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) matrix[i][i] = 1.0;

    if (n < 2) return matrix;

    const pairs: { i: number; j: number }[] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push({ i, j });

    await Promise.all(pairs.map(({ i, j }) =>
        visionLimit(async () => {
            try {
                const r = await compareImagesSemantically(files[i].buffer!, files[i].mimeType, files[j].buffer!, files[j].mimeType);
                matrix[i][j] = matrix[j][i] = r.similarity;
            } catch {
                matrix[i][j] = matrix[j][i] = 0.5;
            }
        })
    ));

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
    const median = sims[Math.floor(sims.length / 2)];
    return Math.max(0.55, Math.min(0.85, median + 0.05));
}

function bucketStats(indices: number[], matrix: number[][]): number {
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

// ========== MAIN ==========

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('Usage: npm run test:cluster-hybrid-parallel -- /path/to/images.zip');
        process.exit(1);
    }

    const inputPath = args[0];
    if (!existsSync(inputPath)) { console.error('Path not found'); process.exit(1); }
    if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY required'); process.exit(1); }

    console.log('🚀 PAL Parallelized Hybrid Clustering\n');
    console.log(`📊 Concurrency: Labels=${LABEL_CONCURRENCY}, Embeddings=${EMBEDDING_CONCURRENCY}, Vision=${VISION_CONCURRENCY}\n`);

    let extractDir: string, outputDir: string;

    if (inputPath.endsWith('.zip')) {
        const zipDir = dirname(inputPath), zipName = basename(inputPath, '.zip');
        extractDir = join(zipDir, `${zipName}_extracted`);
        outputDir = join(zipDir, `${zipName}_hybrid_parallel`);
        mkdirSync(extractDir, { recursive: true });
        console.log(`📦 Extracting...\n`);
        new AdmZip(inputPath).extractAllTo(extractDir, true);
    } else {
        extractDir = inputPath;
        outputDir = join(dirname(inputPath), `${basename(inputPath)}_hybrid_parallel`);
    }

    const imageFiles: MediaFile[] = getAllFiles(extractDir)
        .filter(f => getMediaType(f))
        .map(f => ({ path: f, filename: basename(f), mimeType: getMimeType(basename(f)) }));

    console.log(`📸 ${imageFiles.length} images\n`);
    if (imageFiles.length < 2) { console.error('Need 2+ images'); process.exit(1); }

    // Load all buffers in parallel
    console.log('📥 Loading buffers...');
    imageFiles.forEach(f => { f.buffer = readFileSync(f.path); });

    // ===== PHASE 1 =====
    console.log('\n' + '━'.repeat(60));
    console.log('📋 PHASE 1: Parallel Labeling & Embedding');
    console.log('━'.repeat(60) + '\n');

    const startPhase1 = Date.now();

    // Parallel labeling
    console.log(`🏷️  Labeling (${LABEL_CONCURRENCY} parallel)...`);
    let labelDone = 0;
    await Promise.all(imageFiles.map(file =>
        labelLimit(async () => {
            try { file.label = await generateImageLabel(file.buffer!, file.mimeType); }
            catch { file.label = file.filename; }
            labelDone++;
            if (labelDone % 10 === 0) console.log(`   ${labelDone}/${imageFiles.length}`);
        })
    ));
    console.log(`   ✓ ${imageFiles.length} labeled\n`);

    // Parallel embedding
    console.log(`📊 Embedding (${EMBEDDING_CONCURRENCY} parallel)...`);
    let embedDone = 0;
    await Promise.all(imageFiles.map(file =>
        embeddingLimit(async () => {
            if (!file.label) return;
            try { file.embedding = await generateEmbedding(file.label); }
            catch { file.embedding = []; }
            embedDone++;
            if (embedDone % 10 === 0) console.log(`   ${embedDone}/${imageFiles.length}`);
        })
    ));
    console.log(`   ✓ ${imageFiles.length} embedded\n`);

    const filesWithEmb = imageFiles.filter(f => f.embedding?.length);
    const embeddings = filesWithEmb.map(f => f.embedding!);

    // Rough clustering
    console.log(`🔗 Rough clustering (threshold: ${ROUGH_CLUSTER_THRESHOLD})...`);
    const roughAssign = roughCluster(embeddings, ROUGH_CLUSTER_THRESHOLD);
    const numRough = Math.max(...roughAssign) + 1;
    console.log(`   ✓ ${numRough} rough buckets\n`);

    const phase1Time = Date.now() - startPhase1;
    console.log(`⏱️  Phase 1 complete: ${(phase1Time / 1000).toFixed(1)}s\n`);

    // Group by bucket
    const roughBuckets = new Map<number, number[]>();
    roughAssign.forEach((c, i) => {
        if (!roughBuckets.has(c)) roughBuckets.set(c, []);
        roughBuckets.get(c)!.push(i);
    });

    // ===== PHASE 2 =====
    console.log('━'.repeat(60));
    console.log('🔍 PHASE 2: Parallel Semantic Refinement');
    console.log('━'.repeat(60) + '\n');

    const startPhase2 = Date.now();
    const finalBuckets: Bucket[] = [];
    let totalComps = 0, bucketCounter = 0;

    // Process all rough buckets in parallel
    const bucketResults = await Promise.all(
        Array.from(roughBuckets.entries()).map(async ([roughId, indices]) => {
            const bucketFiles = indices.map(i => filesWithEmb[i]);
            const n = bucketFiles.length;
            const pairs = (n * (n - 1)) / 2;

            console.log(`📦 Bucket ${roughId + 1}: ${n} images, ${pairs} comparisons`);

            if (n === 1) {
                return [{ files: bucketFiles, indices, avgSim: 1.0 }];
            }

            const matrix = await buildSemanticMatrix(bucketFiles);
            const threshold = getOptimalThreshold(matrix);
            const subAssign = refineWithSemantic(matrix, threshold);
            const numSub = Math.max(...subAssign) + 1;

            console.log(`   → ${numSub} sub-bucket(s) (threshold: ${threshold.toFixed(2)})`);

            const results: { files: MediaFile[]; indices: number[]; avgSim: number }[] = [];

            for (let s = 0; s < numSub; s++) {
                const subIdx = subAssign.map((a, i) => a === s ? i : -1).filter(i => i !== -1);
                const subFiles = subIdx.map(i => bucketFiles[i]);
                const globalIdx = subIdx.map(i => indices[i]);
                const avgSim = bucketStats(subIdx, matrix);
                results.push({ files: subFiles, indices: globalIdx, avgSim });
            }

            return results;
        })
    );

    // Flatten and generate names in parallel
    const flatBuckets = bucketResults.flat();
    totalComps = Array.from(roughBuckets.values()).reduce((sum, idx) => {
        const n = idx.length;
        return sum + (n * (n - 1)) / 2;
    }, 0);

    console.log(`\n📝 Generating ${flatBuckets.length} cluster names (${CLUSTER_NAME_CONCURRENCY} parallel)...`);

    await Promise.all(flatBuckets.map((b, i) =>
        nameLimit(async () => {
            const labels = b.files.map(f => f.label || '').filter(Boolean);
            let name = `Cluster_${i + 1}`;
            try { if (labels.length > 0) name = await generateClusterName(labels); } catch { }
            finalBuckets.push({
                id: String(++bucketCounter),
                name,
                files: b.files,
                indices: b.indices,
                avgSimilarity: b.avgSim,
            });
        })
    ));

    const phase2Time = Date.now() - startPhase2;
    console.log(`\n⏱️  Phase 2 complete: ${(phase2Time / 1000).toFixed(1)}s`);

    // Sort by size
    finalBuckets.sort((a, b) => b.files.length - a.files.length);

    // ===== ORGANIZE =====
    console.log('\n' + '━'.repeat(60));
    console.log('📁 Organizing files');
    console.log('━'.repeat(60) + '\n');

    mkdirSync(outputDir, { recursive: true });

    const fullPairs = (imageFiles.length * (imageFiles.length - 1)) / 2;
    const report = {
        method: 'Parallelized Hybrid Clustering',
        concurrency: { labels: LABEL_CONCURRENCY, embeddings: EMBEDDING_CONCURRENCY, vision: VISION_CONCURRENCY },
        totalImages: imageFiles.length,
        roughBuckets: numRough,
        finalBuckets: finalBuckets.length,
        comparisons: { used: totalComps, fullWouldBe: fullPairs, saved: fullPairs - totalComps, savingsPercent: Math.round((1 - totalComps / fullPairs) * 100) },
        timing: { phase1Seconds: phase1Time / 1000, phase2Seconds: phase2Time / 1000, totalSeconds: (phase1Time + phase2Time) / 1000 },
        buckets: finalBuckets.map(b => ({ name: b.name, count: b.files.length, avgSimilarity: b.avgSimilarity })),
    };
    writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));

    for (const b of finalBuckets) {
        const dir = join(outputDir, sanitizeDirName(b.name));
        mkdirSync(dir, { recursive: true });
        console.log(`📂 ${sanitizeDirName(b.name)}/ (${b.files.length})`);
        for (const f of b.files) copyFileSync(f.path, join(dir, f.filename));
    }

    // ===== RESULTS =====
    console.log('\n' + '═'.repeat(70));
    console.log('📋 RESULTS');
    console.log('═'.repeat(70));
    console.log(`\n📂 ${outputDir}`);
    console.log(`⏱️  Total: ${report.timing.totalSeconds.toFixed(1)}s (Phase 1: ${report.timing.phase1Seconds.toFixed(1)}s, Phase 2: ${report.timing.phase2Seconds.toFixed(1)}s)`);
    console.log(`💰 Saved ${report.comparisons.saved} comparisons (${report.comparisons.savingsPercent}%)\n`);

    console.log('┌' + '─'.repeat(42) + '┬' + '─'.repeat(7) + '┬' + '─'.repeat(9) + '┐');
    console.log('│ Bucket                                   │ Count │ Avg Sim │');
    console.log('├' + '─'.repeat(42) + '┼' + '─'.repeat(7) + '┼' + '─'.repeat(9) + '┤');
    for (const b of finalBuckets) {
        console.log(`│ ${b.name.slice(0, 40).padEnd(40)} │ ${String(b.files.length).padStart(5)} │ ${b.avgSimilarity.toFixed(3).padStart(7)} │`);
    }
    console.log('└' + '─'.repeat(42) + '┴' + '─'.repeat(7) + '┴' + '─'.repeat(9) + '┘\n');
}

main().catch(console.error);
