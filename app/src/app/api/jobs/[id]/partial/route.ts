/**
 * Partial Job Results API - Get results even while processing
 * GET /api/jobs/:id/partial - Get current state including any processed images
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

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
                mediaFiles: {
                    orderBy: { createdAt: 'asc' },
                },
            },
        });

        if (!job) {
            return NextResponse.json(
                { error: 'Job not found' },
                { status: 404 }
            );
        }

        // Build buckets with images
        const buckets = job.buckets.map(bucket => {
            const images = bucket.mediaFiles.filter(f => f.mediaType === 'image');
            const videos = bucket.mediaFiles.filter(f => f.mediaType === 'video');

            return {
                id: bucket.id,
                name: bucket.name,
                images: images.map(f => ({
                    id: f.id,
                    filename: f.filename,
                    s3Url: f.s3Url,
                    label: f.label,
                    eloScore: f.eloScore,
                    isTopPick: f.isTopPick,
                })),
                videos: videos.map(f => ({
                    id: f.id,
                    filename: f.filename,
                    s3Url: f.s3Url,
                    label: f.label,
                    eloScore: f.eloScore,
                    isTopPick: f.isTopPick,
                })),
            };
        });

        // Get images not yet in buckets
        const unclusteredImages = job.mediaFiles
            .filter(f => f.mediaType === 'image' && !f.bucketId)
            .map(f => ({
                id: f.id,
                filename: f.filename,
                s3Url: f.s3Url,
                label: f.label,
                eloScore: f.eloScore,
                isTopPick: f.isTopPick,
            }));

        return NextResponse.json({
            job: {
                id: job.id,
                name: job.name,
                status: job.status,
                totalFiles: job.totalFiles,
                processedFiles: job.processedFiles,
                progress: job.totalFiles > 0
                    ? Math.round((job.processedFiles / job.totalFiles) * 100)
                    : 0,
                createdAt: job.createdAt,
                updatedAt: job.updatedAt,
                completedAt: job.completedAt,
            },
            buckets,
            unclusteredImages,
            totalImages: job.mediaFiles.filter(f => f.mediaType === 'image').length,
        });
    } catch (error) {
        console.error('Error fetching partial results:', error);
        return NextResponse.json(
            { error: 'Failed to fetch partial results' },
            { status: 500 }
        );
    }
}
