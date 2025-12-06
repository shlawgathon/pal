/**
 * Custom server for Next.js with WebSocket support
 * 
 * This server combines:
 * - Express for HTTP requests
 * - Next.js for rendering
 * - ws for WebSocket connections
 */

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { initUploadSession, handleChunk, cleanupSession } from './src/lib/upload-handler';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

interface WSInitMessage {
    type: 'init';
    totalChunks: number;
    totalSize: number;
}

interface WSChunkMessage {
    type: 'chunk';
    jobId: string;
    chunkIndex: number;
}

app.prepare().then(() => {
    const server = createServer((req, res) => {
        const parsedUrl = parse(req.url || '', true);
        handle(req, res, parsedUrl);
    });

    // Create WebSocket server
    const wss = new WebSocketServer({
        server,
        path: '/ws/upload',
    });

    // Track active connections
    const connections = new Map<WebSocket, { jobId?: string }>();

    wss.on('connection', (ws: WebSocket) => {
        console.log('WebSocket client connected');
        connections.set(ws, {});

        ws.on('message', async (data: Buffer | string, isBinary: boolean) => {
            const state = connections.get(ws);
            if (!state) return;

            try {
                if (isBinary) {
                    // Binary data = chunk upload
                    if (!state.jobId) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: 'No active upload session' }
                        }));
                        return;
                    }

                    // Extract chunk index from first 4 bytes, rest is data
                    const buffer = data as Buffer;
                    const chunkIndex = buffer.readUInt32BE(0);
                    const chunkData = buffer.slice(4);

                    await handleChunk(ws, state.jobId, chunkData, chunkIndex);
                } else {
                    // Text data = control message
                    const message = JSON.parse(data.toString()) as WSInitMessage | WSChunkMessage;

                    if (message.type === 'init') {
                        // Initialize new upload session
                        const jobId = await initUploadSession(
                            ws,
                            message.totalChunks,
                            message.totalSize
                        );
                        state.jobId = jobId;
                        console.log(`Upload session started: ${jobId}`);
                    }
                }
            } catch (error) {
                console.error('WebSocket message error:', error);
                ws.send(JSON.stringify({
                    type: 'error',
                    data: { message: error instanceof Error ? error.message : 'Unknown error' }
                }));
            }
        });

        ws.on('close', () => {
            const state = connections.get(ws);
            if (state?.jobId) {
                cleanupSession(state.jobId);
            }
            connections.delete(ws);
            console.log('WebSocket client disconnected');
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    });

    server.listen(port, () => {
        console.log(`> Server ready on http://${hostname}:${port}`);
        console.log(`> WebSocket server ready on ws://${hostname}:${port}/ws/upload`);
    });
});
