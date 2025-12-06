/**
 * Union-Find Clustering Test
 *
 * Algorithm:
 * 1. Compare function: LLM decides if two photos are same or different category
 * 2. Iterative clustering: For each photo, compare to existing bucket representatives
 *    - If matches a bucket, add to that bucket
 *    - If no match, create new bucket
 * 3. Ranking: Round-robin comparison within each bucket to get ELO scores
 */

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// ========== TYPES ==========

interface Photo {
    id: string;
    path: string;
    buffer: Buffer;
    mimeType: string;
    label?: string;
    eloScore: number;
}

interface Bucket {
    id: string;
    name: string;
    photos: Photo[];
    representative: Photo; // First photo added, used for comparisons
}

// ========== COMPARE FUNCTION ==========

/**
 * Compare two photos and determine if they belong to the same category
 * Returns true if same category, false if different
 */
async function comparePhotos(photo1: Photo, photo2: Photo): Promise<boolean> {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

    const prompt = `We are trying to dedup a list of images. You are acting as an agent that is part of a larger system to rank takes of the same shot.
    
Your job is to decide whether these two photos are the exact same take of an image or if they are not.

A photo is the same take if it is:
- slightly different positioning of the same object, but obviously taken at the same time
- slightly different shading, but obviously taken at the exact same time

A photo is a different take if it is:
- the same object but taken at a different time
- a different object taken at a different time

If you think that they are the exact same take, output the word "SAME". if they are different images, output the word "DIFFERENT".
`;

    try {
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    mimeType: photo1.mimeType,
                    data: photo1.buffer.toString('base64'),
                },
            },
            {
                inlineData: {
                    mimeType: photo2.mimeType,
                    data: photo2.buffer.toString('base64'),
                },
            },
        ]);

        const response = result.response.text().trim().toUpperCase();
        console.log(`    Compare: ${photo1.id} vs ${photo2.id} = ${response}`);
        return response.includes('SAME');
    } catch (error) {
        console.error(`    Compare error:`, error);
        return false; // Default to different on error
    }
}

/**
 * Generate a label for a photo
 */
async function generateLabel(photo: Photo): Promise<string> {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

    const prompt = `Describe this image in 3-5 words. Be specific about the main subject.`;

    try {
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    mimeType: photo.mimeType,
                    data: photo.buffer.toString('base64'),
                },
            },
        ]);
        return result.response.text().trim();
    } catch (error) {
        return 'Unknown';
    }
}

/**
 * Generate a name for a bucket based on its photos
 */
async function generateBucketName(photos: Photo[]): Promise<string> {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

    const labels = photos.map(p => p.label).filter(Boolean).join(', ');
    const prompt = `Given these photo descriptions: "${labels}"
    
Generate a short, catchy category name (2-4 words) that describes what these photos have in common.
Respond with ONLY the category name, nothing else.`;

    try {
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        return `Cluster ${Date.now()}`;
    }
}

// ========== RANKING FUNCTION ==========

/**
 * Compare two photos and determine which is better
 * Returns 1 if photo1 wins, 2 if photo2 wins
 */
async function rankPhotos(photo1: Photo, photo2: Photo): Promise<{ winner: 1 | 2; confidence: number }> {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

    const prompt = `You are a professional photo judge. Compare these two photos and decide which one is BETTER.

Consider:
- Composition and framing
- Lighting and exposure
- Sharpness and focus
- Visual interest and impact
- Technical quality

Respond in this exact format:
WINNER: 1 or 2
CONFIDENCE: low, medium, or high`;

    try {
        const result = await model.generateContent([
            prompt,
            { inlineData: { mimeType: photo1.mimeType, data: photo1.buffer.toString('base64') } },
            { inlineData: { mimeType: photo2.mimeType, data: photo2.buffer.toString('base64') } },
        ]);

        const response = result.response.text();
        const winnerMatch = response.match(/WINNER:\s*([12])/i);
        const confMatch = response.match(/CONFIDENCE:\s*(low|medium|high)/i);

        const winner = winnerMatch ? (parseInt(winnerMatch[1]) as 1 | 2) : 1;
        const confMap: Record<string, number> = { low: 0.6, medium: 0.8, high: 1.0 };
        const confidence = confMatch ? confMap[confMatch[1].toLowerCase()] || 0.8 : 0.8;

        return { winner, confidence };
    } catch (error) {
        return { winner: 1, confidence: 0.5 };
    }
}

/**
 * Update ELO scores after a match
 */
function updateElo(winner: Photo, loser: Photo, confidence: number): void {
    const K = 32 * confidence;
    const expectedWinner = 1 / (1 + Math.pow(10, (loser.eloScore - winner.eloScore) / 400));
    const expectedLoser = 1 / (1 + Math.pow(10, (winner.eloScore - loser.eloScore) / 400));

    winner.eloScore += K * (1 - expectedWinner);
    loser.eloScore += K * (0 - expectedLoser);
}

// ========== MAIN ALGORITHM ==========

/**
 * Load photos from a zip file or directory
 */
async function loadPhotos(inputPath: string): Promise<Photo[]> {
    const photos: Photo[] = [];
    let extractDir: string;

    if (inputPath.endsWith('.zip')) {
        extractDir = inputPath.replace('.zip', '_extracted');
        if (!fs.existsSync(extractDir)) {
            console.log(`Extracting ${inputPath}...`);
            const zip = new AdmZip(inputPath);
            zip.extractAllTo(extractDir, true);
        }
    } else {
        extractDir = inputPath;
    }

    const walkDir = (dir: string) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);

            if (stat.isDirectory()) {
                if (!file.startsWith('.') && file !== '__MACOSX') {
                    walkDir(filePath);
                }
            } else if (stat.isFile()) {
                const ext = path.extname(file).toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) && !file.startsWith('._')) {
                    const mimeType = ext === '.png' ? 'image/png' :
                        ext === '.webp' ? 'image/webp' :
                            ext === '.gif' ? 'image/gif' : 'image/jpeg';
                    photos.push({
                        id: file,
                        path: filePath,
                        buffer: fs.readFileSync(filePath),
                        mimeType,
                        eloScore: 1000,
                    });
                }
            }
        }
    };

    walkDir(extractDir);
    console.log(`Loaded ${photos.length} photos\n`);
    return photos;
}

/**
 * Union-Find Clustering - Iterative approach
 */
async function clusterPhotos(photos: Photo[]): Promise<Bucket[]> {
    const buckets: Bucket[] = [];
    let bucketCounter = 0;

    console.log('=== CLUSTERING ===\n');

    for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        console.log(`Processing ${i + 1}/${photos.length}: ${photo.id}`);

        // Generate label for this photo
        photo.label = await generateLabel(photo);
        console.log(`  Label: ${photo.label}`);

        let matchedBucket: Bucket | null = null;

        // Compare to each existing bucket's representative
        for (const bucket of buckets) {
            const isSame = await comparePhotos(photo, bucket.representative);
            if (isSame) {
                matchedBucket = bucket;
                break;
            }
        }

        if (matchedBucket) {
            // Add to existing bucket
            matchedBucket.photos.push(photo);
            console.log(`  -> Added to bucket: ${matchedBucket.name} (${matchedBucket.photos.length} photos)\n`);
        } else {
            // Create new bucket
            bucketCounter++;
            const newBucket: Bucket = {
                id: `bucket-${bucketCounter}`,
                name: `Bucket ${bucketCounter}`,
                photos: [photo],
                representative: photo,
            };
            buckets.push(newBucket);
            console.log(`  -> Created new bucket #${bucketCounter}\n`);
        }
    }

    // Generate proper names for buckets
    console.log('\n=== NAMING BUCKETS ===\n');
    for (const bucket of buckets) {
        bucket.name = await generateBucketName(bucket.photos);
        console.log(`${bucket.id}: "${bucket.name}" (${bucket.photos.length} photos)`);
    }

    return buckets;
}

/**
 * Rank photos within each bucket using round-robin comparison
 */
async function rankBucket(bucket: Bucket): Promise<void> {
    const photos = bucket.photos;
    if (photos.length < 2) return;

    console.log(`\nRanking "${bucket.name}" (${photos.length} photos)...`);

    // Round-robin: compare each photo to every other
    const matches: { i: number; j: number }[] = [];
    for (let i = 0; i < photos.length; i++) {
        for (let j = i + 1; j < photos.length; j++) {
            matches.push({ i, j });
        }
    }

    console.log(`  Running ${matches.length} comparisons...`);

    let completed = 0;
    for (const { i, j } of matches) {
        const result = await rankPhotos(photos[i], photos[j]);
        const winner = result.winner === 1 ? photos[i] : photos[j];
        const loser = result.winner === 1 ? photos[j] : photos[i];
        updateElo(winner, loser, result.confidence);
        completed++;

        if (completed % 5 === 0 || completed === matches.length) {
            console.log(`  Progress: ${completed}/${matches.length}`);
        }
    }

    // Sort by ELO
    photos.sort((a, b) => b.eloScore - a.eloScore);

    console.log(`  Rankings:`);
    photos.forEach((p, idx) => {
        console.log(`    #${idx + 1}: ${p.id} (ELO: ${p.eloScore.toFixed(0)})`);
    });
}

/**
 * Output results to directories
 */
function outputResults(buckets: Bucket[], outputDir: string): void {
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    for (const bucket of buckets) {
        const bucketDir = path.join(outputDir, bucket.name.replace(/[^a-zA-Z0-9]/g, '_'));
        fs.mkdirSync(bucketDir, { recursive: true });

        bucket.photos.forEach((photo, idx) => {
            const ext = path.extname(photo.path);
            const newName = `${String(idx + 1).padStart(2, '0')}_${photo.eloScore.toFixed(0)}${ext}`;
            fs.copyFileSync(photo.path, path.join(bucketDir, newName));
        });
    }

    console.log(`\nResults saved to: ${outputDir}`);
}

// ========== MAIN ==========

async function main() {
    const inputPath = process.argv[2];
    if (!inputPath) {
        console.error('Usage: npx ts-node test/test-union-find.ts <path-to-zip-or-directory>');
        process.exit(1);
    }

    console.log('='.repeat(60));
    console.log('Union-Find Clustering Test');
    console.log('='.repeat(60));
    console.log();

    // Load photos
    const photos = await loadPhotos(inputPath);
    if (photos.length === 0) {
        console.error('No photos found');
        process.exit(1);
    }

    // Cluster using union-find
    const buckets = await clusterPhotos(photos);

    // Rank each bucket
    console.log('\n=== RANKING ===');
    for (const bucket of buckets) {
        await rankBucket(bucket);
    }

    // Output results
    const outputDir = inputPath.endsWith('.zip')
        ? inputPath.replace('.zip', '_unionfind_results')
        : inputPath + '_unionfind_results';
    outputResults(buckets, outputDir);

    // Summary
    console.log('\n=== SUMMARY ===');
    console.log(`Total photos: ${photos.length}`);
    console.log(`Total buckets: ${buckets.length}`);
    buckets.forEach(b => {
        console.log(`  - ${b.name}: ${b.photos.length} photos`);
        if (b.photos.length > 0) {
            console.log(`    Top: ${b.photos[0].id} (ELO: ${b.photos[0].eloScore.toFixed(0)})`);
        }
    });
}

main().catch(console.error);
