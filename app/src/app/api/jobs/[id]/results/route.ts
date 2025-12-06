/**
 * Job Results API - Get ranked results
 * GET /api/jobs/:id/results - Get final ranked buckets and top picks
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import type { JobResults, BucketResult, MediaFileInfo } from '@/lib/types';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(
    request: NextRequest,
    { params }: RouteParams
) {
    try {
        const { id } = await params;

        const job = await prisma.job.findUnique({
            where: { id },
            include: {
                buckets: {
                    include: {
                        mediaFiles: {
                            orderBy: { eloScore: 'desc' },
                        },
                    },
                },
            },
        });

        if (!job) {
            return NextResponse.json(
                { error: 'Job not found' },
                { status: 404 }
            );
        }

        if (job.status !== 'completed') {
            return NextResponse.json(
                {
                    error: 'Job not completed',
                    status: job.status,
                },
                { status: 400 }
            );
        }

        const buckets: BucketResult[] = job.buckets.map(bucket => {
            const images = bucket.mediaFiles.filter(f => f.mediaType === 'image');
            const videos = bucket.mediaFiles.filter(f => f.mediaType === 'video');

            const mapToMediaInfo = (file: typeof bucket.mediaFiles[0]): MediaFileInfo => ({
                id: file.id,
                filename: file.filename,
                mediaType: file.mediaType as 'image' | 'video',
                s3Url: file.s3Url,
                label: file.label || undefined,
                eloScore: file.eloScore,
                isTopPick: file.isTopPick,
                enhancedS3Url: file.enhancedS3Url || undefined,
            });

            return {
                id: bucket.id,
                name: bucket.name,
                topImages: images.filter(f => f.isTopPick).map(mapToMediaInfo),
                topVideos: videos.filter(f => f.isTopPick).map(mapToMediaInfo),
                allImages: images.map(mapToMediaInfo),
                allVideos: videos.map(mapToMediaInfo),
            };
        });

        const results: JobResults = {
            job: {
                id: job.id,
                status: 'completed',
                totalFiles: job.totalFiles,
                processedFiles: job.processedFiles,
                progress: 100,
                error: job.error || undefined,
                createdAt: job.createdAt,
                updatedAt: job.updatedAt,
                completedAt: job.completedAt || undefined,
            },
            buckets,
        };

        return NextResponse.json(results);
    } catch (error) {
        console.error('Error fetching results:', error);
        return NextResponse.json(
            { error: 'Failed to fetch results' },
            { status: 500 }
        );
    }
}
