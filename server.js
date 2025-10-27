const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const sharp = require('sharp');
const express = require('express');
const { spawn } = require('child_process');
const { randomUUID } = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- WebRTC Signaling Data Structures ---
const rooms = new Map();
const peers = new Map();

// --- Existing Data Structures ---
const mjpegClients = new Set();
let isIntegrating = false;
let captureProcess = null;

// Default settings
let channelSettings = {
    leftAudioChannel: 0,
    rightAudioChannel: 1,
    device: 0,
    mode: -1
};

// --- WebRTC Helper Functions ---
const getRoom = (room) => {
    if (!rooms.has(room)) {
        rooms.set(room, { pubs: new Set(), subs: new Set() });
    }
    return rooms.get(room);
};

const safeSend = (ws, obj) => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
};

// --- System Stats ---
let lastCpuTimes = os.cpus().map(c => c.times);

function getCpuUsage() {
    const currentCpuTimes = os.cpus().map(c => c.times);
    const usage = currentCpuTimes.map((times, i) => {
        const last = lastCpuTimes[i];
        const idle = times.idle - last.idle;
        const total = (times.user - last.user) + (times.nice - last.nice) + (times.sys - last.sys) + (times.irq - last.irq) + idle;
        return total > 0 ? 1 - (idle / total) : 0;
    });
    lastCpuTimes = currentCpuTimes;
    const avgUsage = usage.reduce((a, b) => a + b, 0) / usage.length;
    return avgUsage;
}

setInterval(() => {
    const cpuUsage = getCpuUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const statsMsg = JSON.stringify({
        type: 'system_stats',
        cpu: cpuUsage * 100,
        memory: {
            percent: (usedMem / totalMem) * 100,
            used: usedMem,
            total: totalMem
        }
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(statsMsg);
        }
    });
}, 2000); // Send stats every 2 seconds

// --- Capture Process Management ---
function startCapture() {
    const spawnProcess = () => {
        const args = [
            '-d', channelSettings.device,
            '-m', channelSettings.mode,
            '-c', 16, // Always capture 16 channels
            '-L', channelSettings.leftAudioChannel,
            '-R', channelSettings.rightAudioChannel
        ];

        console.log(`Starting Capture with args: ${args.join(' ')}`);
        captureProcess = spawn(path.join(__dirname, 'Capture'), args);

        captureProcess.stdout.on('data', (data) => {
            console.log(`Capture stdout: ${data}`);
        });

        captureProcess.stderr.on('data', (data) => {
            console.error(`Capture stderr: ${data}`);
        });

        captureProcess.on('close', (code) => {
            console.log(`Capture process exited with code ${code}`);
            captureProcess = null; // Clear the process handle
        });

        captureProcess.on('error', (err) => {
            console.error('Failed to start Capture process:', err);
        });
    };

    if (captureProcess) {
        console.log('Stopping existing Capture process...');
        captureProcess.once('close', () => {
            console.log('Previous Capture process terminated. Starting new one.');
            spawnProcess();
        });
        captureProcess.kill('SIGKILL');
    } else {
        spawnProcess();
    }
}

// --- Express Setup ---
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/settings', (req, res) => {
    res.json(channelSettings);
});

app.post('/api/settings', (req, res) => {
    const { leftChannel, rightChannel } = req.body;
    if (leftChannel !== undefined && rightChannel !== undefined) {
        channelSettings.leftAudioChannel = parseInt(leftChannel, 10);
        channelSettings.rightAudioChannel = parseInt(rightChannel, 10);
        console.log('Updated channel settings:', channelSettings);
        
        startCapture(); // Restart capture process with new settings

        res.json({ success: true, message: 'Settings updated and Capture process restarted.' });
    } else {
        res.status(400).json({ success: false, message: 'Invalid settings provided.' });
    }
});

app.get('/vectorscope.mjpeg', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=--frame',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
        'Pragma': 'no-cache'
    });
    mjpegClients.add(res);
    console.log(`MJPEG stream client connected. Total clients: ${mjpegClients.size}`);

    req.on('close', () => {
        mjpegClients.delete(res);
        console.log(`MJPEG stream client disconnected. Total clients: ${mjpegClients.size}`);
    });
});

// --- WebSocket Handling ---
wss.on('connection', (ws, req) => {
    console.log('WebSocket client connected');

    // --- WebRTC Signaling Connection Logic ---
    const url = new URL(req.url, `http://${req.headers.host}`);
    const role = url.searchParams.get("role") || "sub";
    const room = url.searchParams.get("room") || "default";
    const page = url.searchParams.get("page") || "audio"; // Default to audio
    const id = randomUUID();

    peers.set(ws, { id, role, room, page });
    const R = getRoom(room);
    (role === "pub" ? R.pubs : R.subs).add(ws);
    console.log(`[JOIN] room=${room} role=${role} id=${id} page=${page}`);

    // If a new subscriber joins, ask the publisher to send an offer.
    if (role === "sub") {
        for (const pub of R.pubs) {
            safeSend(pub, { type: "need-offer", to: id, room });
        }
    }

    // --- Existing Functionality ---
    ws.send(JSON.stringify({ type: 'integration_state', is_integrating: isIntegrating }));
    ws.send(JSON.stringify({ type: 'settings', ...channelSettings }));

    ws.on('message', message => {
        let msg;
        try {
            const txt = message instanceof Buffer ? message.toString() : message;
            msg = JSON.parse(txt);
        } catch (e) {
            // console.error('Failed to parse WebSocket message:', e);
            return;
        }

        const me = peers.get(ws);
        if (!me) return;

        // --- WebRTC Signaling Message Routing ---
        if (msg.to) {
            msg.from = me.id;
            const R = rooms.get(me.room);
            if (!R) return;

            for (const peer of [...R.pubs, ...R.subs]) {
                const meta = peers.get(peer);
                if (meta && meta.id === msg.to) {
                    safeSend(peer, msg);
                    return; // Message routed, do not process further.
                }
            }
        }

        // --- Existing Message Handling ---
        if (msg.command) {
            if (msg.command === 'start_integration') {
                isIntegrating = true;
            } else if (msg.command === 'stop_integration') {
                isIntegrating = false;
            }

            const integrationStateMsg = JSON.stringify({ type: 'integration_state', is_integrating: isIntegrating });

            // Broadcast integration state only to audio clients
            wss.clients.forEach(client => {
                const peer = peers.get(client);
                if (peer && peer.page === 'audio' && client.readyState === WebSocket.OPEN) {
                    client.send(integrationStateMsg);
                }
            });
        } else if (msg.type === 'vectorscope' && msg.data) {
            const ppmFrame = Buffer.from(msg.data, 'base64');
            const headerMatch = ppmFrame.toString('ascii', 0, 30).match(/P6\n(\d+)\s(\d+)\n255\n/);
            if (!headerMatch) return;

            const width = parseInt(headerMatch[1], 10);
            const height = parseInt(headerMatch[2], 10);

            sharp(ppmFrame, { raw: { width, height, channels: 3 } })
                .jpeg()
                .toBuffer()
                .then(jpegFrame => {
                    mjpegClients.forEach(client => {
                        client.write('--frame\r\n');
                        client.write('Content-Type: image/jpeg\r\n');
                        client.write(`Content-Length: ${jpegFrame.length}\r\n`);
                        client.write('\r\n');
                        client.write(jpegFrame);
                        client.write('\r\n');
                    });
                })
                .catch(err => {});
        } else {
            // Broadcast audio telemetry only to audio clients
            const audioTelemetryTypes = ['lkfs', 's_lkfs', 'i_lkfs', 'levels', 'correlation', 'eq', 'lra'];
            if (audioTelemetryTypes.includes(msg.type)) {
                const msgStr = JSON.stringify(msg);
                wss.clients.forEach(client => {
                    const peer = peers.get(client);
                    if (peer && peer.page === 'audio' && client.readyState === WebSocket.OPEN) {
                        client.send(msgStr);
                    }
                });
            }
        }
    });

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
        const meta = peers.get(ws);
        if (!meta) return;

        const { role, room, id } = meta;
        const R = rooms.get(room);
        if (R) {
            (role === "pub" ? R.pubs : R.subs).delete(ws);
            peers.delete(ws);
            console.log(`[LEAVE] room=${room} role=${role} id=${id}`);
        }
    });
});

// --- Server Start ---
const PORT = 8080;
server.listen(PORT, () => {
    console.log(`Server is listening on http://localhost:${PORT}`);
    startCapture(); // Initial start of the Capture process
});
