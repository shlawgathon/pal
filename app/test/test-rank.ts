#!/usr/bin/env npx tsx
/**
 * Tournament Ranking Test
 *
 * Usage: npm run test:rank -- /path/to/categorized_images/
 *
 * Takes a directory with subdirectories (clusters) and runs the
 * tournament ranking system on each cluster to find the top 3 images.
 */

import 'dotenv/config';
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import pLimit from 'p-limit';

import { compareImages, generateImageLabel } from '../src/lib/gemini';
import { SUPPORTED_IMAGE_EXTENSIONS, ELO_K_FACTOR, ELO_INITIAL_SCORE } from '../src/lib/types';

const COMPARISON_CONCURRENCY = 3;
const limit = pLimit(COMPARISON_CONCURRENCY);

interface MediaFile {
    path: string;
    filename: string;
    mimeType: string;
    buffer: Buffer;
    label?: string;
    eloScore: number;
    wins: number;
    losses: number;
}

interface MatchResult {
    image1: string;
    image2: string;
    winner: string;
    reasoning: string;
    confidence: number;
}

interface ClusterResult {
    name: string;
    totalImages: number;
    totalMatches: number;
    top3: { rank: number; filename: string; eloScore: number; wins: number; losses: number }[];
    allRankings: MediaFile[];
    matches: MatchResult[];
}

// ========== UTILITIES ==========

function getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() || '';
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic' }[ext] || 'image/jpeg';
}

function shouldSkipFile(filename: string): boolean {
    const base = filename.split('/').pop() || filename;
    return base.startsWith('._') || base.startsWith('.') || base.toLowerCase() === 'thumbs.db';
}

function isImage(filename: string): boolean {
    if (shouldSkipFile(filename)) return false;
    const ext = '.' + (filename.toLowerCase().split('.').pop() || '');
    return SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
}

function calculateElo(winnerElo: number, loserElo: number): { winnerNew: number; loserNew: number } {
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoser = 1 - expectedWinner;

    return {
        winnerNew: winnerElo + ELO_K_FACTOR * (1 - expectedWinner),
        loserNew: loserElo + ELO_K_FACTOR * (0 - expectedLoser),
    };
}

// ========== TOURNAMENT ==========

async function runTournament(files: MediaFile[]): Promise<{ rankings: MediaFile[]; matches: MatchResult[] }> {
    const matches: MatchResult[] = [];

    if (files.length < 2) {
        return { rankings: files, matches: [] };
    }

    // Generate round-robin matchups for small sets, or Swiss-style for larger
    const pairs: [number, number][] = [];

    if (files.length <= 8) {
        // Round-robin for small clusters
        for (let i = 0; i < files.length; i++) {
            for (let j = i + 1; j < files.length; j++) {
                pairs.push([i, j]);
            }
        }
    } else {
        // Swiss tournament: ~2*n comparisons instead of n*(n-1)/2
        // Each image plays 3-4 rounds
        const rounds = Math.min(4, files.length - 1);
        const played = new Set<string>();

        for (let round = 0; round < rounds; round++) {
            // Sort by current ELO and pair adjacent
            const sorted = [...files].sort((a, b) => b.eloScore - a.eloScore);
            const indices = sorted.map(f => files.indexOf(f));

            for (let i = 0; i < indices.length - 1; i += 2) {
                const key = [indices[i], indices[i + 1]].sort().join('-');
                if (!played.has(key)) {
                    pairs.push([indices[i], indices[i + 1]]);
                    played.add(key);
                }
            }
        }
    }

    console.log(`   Running ${pairs.length} matches...`);

    // Run matches in parallel
    let completed = 0;
    await Promise.all(
        pairs.map(([i, j]) =>
            limit(async () => {
                const file1 = files[i];
                const file2 = files[j];

                try {
                    const result = await compareImages(
                        file1.buffer, file1.mimeType, file1.label || file1.filename,
                        file2.buffer, file2.mimeType, file2.label || file2.filename
                    );

                    const winner = result.winner === 1 ? file1 : file2;
                    const loser = result.winner === 1 ? file2 : file1;

                    // Update ELO
                    const { winnerNew, loserNew } = calculateElo(winner.eloScore, loser.eloScore);
                    winner.eloScore = winnerNew;
                    loser.eloScore = loserNew;
                    winner.wins++;
                    loser.losses++;

                    matches.push({
                        image1: file1.filename,
                        image2: file2.filename,
                        winner: winner.filename,
                        reasoning: result.reasoning,
                        confidence: result.confidence,
                    });

                } catch (error) {
                    console.error(`   ❌ Match failed: ${file1.filename} vs ${file2.filename}`);
                }

                completed++;
                if (completed % 5 === 0 || completed === pairs.length) {
                    console.log(`   ${completed}/${pairs.length} matches complete`);
                }
            })
        )
    );

    // Sort by ELO
    const rankings = [...files].sort((a, b) => b.eloScore - a.eloScore);

    return { rankings, matches };
}

// ========== MAIN ==========

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: npm run test:rank -- /path/to/categorized_images/');
        console.error('\nThe directory should contain subdirectories (clusters), each with images.');
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

    console.log('🏆 PAL Tournament Ranking Test\n');
    console.log(`Input: ${inputPath}\n`);

    // Find all cluster directories
    const entries = readdirSync(inputPath);
    const clusters: string[] = [];

    for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const fullPath = join(inputPath, entry);
        if (statSync(fullPath).isDirectory()) {
            clusters.push(entry);
        }
    }

    if (clusters.length === 0) {
        console.error('No cluster directories found. Expected subdirectories with images.');
        process.exit(1);
    }

    console.log(`📂 Found ${clusters.length} clusters\n`);

    const results: ClusterResult[] = [];
    const outputDir = join(inputPath, '_rankings');
    mkdirSync(outputDir, { recursive: true });

    for (const clusterName of clusters) {
        const clusterPath = join(inputPath, clusterName);

        console.log('━'.repeat(60));
        console.log(`🗂️  Cluster: ${clusterName}`);
        console.log('━'.repeat(60));

        // Find all images in cluster
        const imageEntries = readdirSync(clusterPath).filter(f => isImage(f));

        if (imageEntries.length === 0) {
            console.log('   No images found, skipping\n');
            continue;
        }

        console.log(`   ${imageEntries.length} images found\n`);

        // Load images
        const files: MediaFile[] = imageEntries.map(filename => ({
            path: join(clusterPath, filename),
            filename,
            mimeType: getMimeType(filename),
            buffer: readFileSync(join(clusterPath, filename)),
            eloScore: ELO_INITIAL_SCORE,
            wins: 0,
            losses: 0,
        }));

        // Generate labels for better comparison
        console.log('   🏷️  Generating labels...');
        await Promise.all(
            files.map(file =>
                limit(async () => {
                    try {
                        file.label = await generateImageLabel(file.buffer, file.mimeType);
                    } catch {
                        file.label = file.filename;
                    }
                })
            )
        );

        // Run tournament
        console.log('\n   🏆 Running tournament...');
        const { rankings, matches } = await runTournament(files);

        // Get top 3
        const top3 = rankings.slice(0, 3).map((f, i) => ({
            rank: i + 1,
            filename: f.filename,
            eloScore: f.eloScore,
            wins: f.wins,
            losses: f.losses,
        }));

        results.push({
            name: clusterName,
            totalImages: files.length,
            totalMatches: matches.length,
            top3,
            allRankings: rankings,
            matches,
        });

        // Copy top 3 to output
        const clusterOutputDir = join(outputDir, clusterName);
        mkdirSync(clusterOutputDir, { recursive: true });

        console.log('\n   🥇 Top 3:');
        const medals = ['🥇', '🥈', '🥉'];
        for (let i = 0; i < Math.min(3, rankings.length); i++) {
            const file = rankings[i];
            console.log(`   ${medals[i]} ${file.filename} (ELO: ${file.eloScore.toFixed(0)}, W:${file.wins} L:${file.losses})`);

            // Copy to top3 folder
            const destPath = join(clusterOutputDir, `${i + 1}_${file.filename}`);
            copyFileSync(file.path, destPath);
        }

        console.log();
    }

    // Save full report
    const report = {
        timestamp: new Date().toISOString(),
        inputPath,
        totalClusters: clusters.length,
        results: results.map(r => ({
            cluster: r.name,
            totalImages: r.totalImages,
            totalMatches: r.totalMatches,
            top3: r.top3,
            allRankings: r.allRankings.map(f => ({
                filename: f.filename,
                eloScore: f.eloScore,
                wins: f.wins,
                losses: f.losses,
            })),
        })),
    };

    writeFileSync(join(outputDir, 'ranking_report.json'), JSON.stringify(report, null, 2));

    // Summary
    console.log('═'.repeat(60));
    console.log('📋 RANKING SUMMARY');
    console.log('═'.repeat(60) + '\n');

    console.log(`📂 Output: ${outputDir}\n`);

    console.log('┌' + '─'.repeat(30) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(25) + '┐');
    console.log('│ Cluster                      │ Images │ Top Pick                │');
    console.log('├' + '─'.repeat(30) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(25) + '┤');

    for (const r of results) {
        const name = r.name.slice(0, 28).padEnd(28);
        const count = String(r.totalImages).padStart(6);
        const topPick = r.top3[0]?.filename.slice(0, 23).padEnd(23) || 'N/A'.padEnd(23);
        console.log(`│ ${name} │ ${count} │ ${topPick} │`);
    }

    console.log('└' + '─'.repeat(30) + '┴' + '─'.repeat(8) + '┴' + '─'.repeat(25) + '┘\n');
    console.log(`✅ Complete! Top 3 from each cluster saved to ${outputDir}\n`);
}

main().catch(console.error);
