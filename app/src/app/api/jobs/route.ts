/**
 * Jobs API - List and create jobs
 * GET /api/jobs - List all jobs
 * POST /api/jobs - Create a new job (returns WebSocket URL)
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import type { JobSummary } from '@/lib/types';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const limit = parseInt(searchParams.get('limit') || '50', 10);
        const offset = parseInt(searchParams.get('offset') || '0', 10);

        const jobs = await prisma.job.findMany({
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
        });

        const total = await prisma.job.count();

        const jobSummaries: JobSummary[] = jobs.map(job => ({
            id: job.id,
            name: job.name || undefined,
            status: job.status as JobSummary['status'],
            totalFiles: job.totalFiles,
            processedFiles: job.processedFiles,
            progress: job.totalFiles > 0
                ? Math.round((job.processedFiles / job.totalFiles) * 100)
                : 0,
            error: job.error || undefined,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            completedAt: job.completedAt || undefined,
        }));

        return NextResponse.json({
            jobs: jobSummaries,
            total,
            limit,
            offset,
        });
    } catch (error) {
        console.error('Error fetching jobs:', error);
        return NextResponse.json(
            { error: 'Failed to fetch jobs' },
            { status: 500 }
        );
    }
}

export async function POST() {
    try {
        // Create a placeholder job - actual job creation happens via WebSocket
        const job = await prisma.job.create({
            data: {
                status: 'uploading',
                totalFiles: 0,
                processedFiles: 0,
            },
        });

        // Return job info with WebSocket URL
        const protocol = process.env.NODE_ENV === 'production' ? 'wss' : 'ws';
        const host = process.env.VERCEL_URL || 'localhost:3000';

        return NextResponse.json({
            jobId: job.id,
            wsUrl: `${protocol}://${host}/ws/upload`,
            status: 'uploading',
        });
    } catch (error) {
        console.error('Error creating job:', error);
        return NextResponse.json(
            { error: 'Failed to create job' },
            { status: 500 }
        );
    }
}
