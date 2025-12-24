const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const express = require('express');
const { spawn, fork } = require('child_process');
const { randomUUID } = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const WEB_ROOT = path.join(__dirname, 'web');

// --- WebRTC Signaling Data Structures ---
const rooms = new Map();
const peers = new Map();

// --- Existing Data Structures ---
let isIntegrating = false;
let captureProcess = null;
let latestVectorscopeSamples = null;

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

function hasAudioSubscribers() {
    for (const [socket, meta] of peers.entries()) {
        if (meta.role === 'sub' && meta.page === 'audio' && socket.readyState === WebSocket.OPEN) {
            return true;
        }
    }
    return false;
}

function detachPeer(ws, reason) {
    const meta = peers.get(ws);
    if (!meta) return;

    const { role, room, id } = meta;
    const R = rooms.get(room);
    if (R) {
        (role === "pub" ? R.pubs : R.subs).delete(ws);
    }
    peers.delete(ws);
    console.log(`[LEAVE] room=${room} role=${role} id=${id}${reason ? ` reason=${reason}` : ''}`);

    if (!hasAudioSubscribers()) {
        latestVectorscopeSamples = null;
    }
}

function terminatePeer(ws, reason) {
    detachPeer(ws, reason);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
    }
}

function sendVectorscopeSamplesToClient(ws, msgStr) {
    if (!msgStr) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    const meta = peers.get(ws);
    if (!meta || meta.role !== 'sub' || meta.page !== 'audio') return;
    if (ws.bufferedAmount > 512 * 1024) {
        return; // Drop if the client is lagging to avoid buildup.
    }
    ws.send(msgStr, err => {
        if (err) {
            console.error('Failed to send vectorscope samples to client:', err);
            terminatePeer(ws, `send_error:${err.code || err.message}`);
        }
    });
}

function broadcastVectorscopeSamples(msgStr) {
    if (!hasAudioSubscribers()) {
        latestVectorscopeSamples = null;
        return;
    }
    latestVectorscopeSamples = msgStr;
    wss.clients.forEach(ws => sendVectorscopeSamplesToClient(ws, msgStr));
}

// --- System Stats (offloaded to worker) ---
const statsWorker = fork(path.join(__dirname, 'statsWorker.js'));

statsWorker.on('message', (msg) => {
    if (!msg || msg.type !== 'system_stats') return;
    const statsMsg = JSON.stringify(msg);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(statsMsg);
        }
    });
});

statsWorker.on('error', (err) => {
    console.error('Stats worker error:', err);
});

statsWorker.on('exit', (code, signal) => {
    console.warn(`Stats worker exited code=${code} signal=${signal}`);
});

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
app.use(express.static(WEB_ROOT));

app.get(['/audio', '/audio.html'], (_req, res) => {
    res.sendFile(path.join(WEB_ROOT, 'audio.html'));
});

app.get(['/video', '/video.html'], (_req, res) => {
    res.sendFile(path.join(WEB_ROOT, 'video.html'));
});

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

    if (role === 'sub' && page === 'audio' && latestVectorscopeSamples) {
        setImmediate(() => sendVectorscopeSamplesToClient(ws, latestVectorscopeSamples));
    }

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

            // Broadcast command to all clients (the C++ app will listen for this)
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(msg));
                }
            });

            const integrationStateMsg = JSON.stringify({ type: 'integration_state', is_integrating: isIntegrating });

            // Broadcast integration state only to audio clients
            wss.clients.forEach(client => {
                const peer = peers.get(client);
                if (peer && peer.page === 'audio' && client.readyState === WebSocket.OPEN) {
                    client.send(integrationStateMsg);
                }
            });
        } else if (msg.type === 'vectorscope_samples' && Array.isArray(msg.samples)) {
            const msgStr = JSON.stringify({ type: 'vectorscope_samples', samples: msg.samples });
            broadcastVectorscopeSamples(msgStr);
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
        detachPeer(ws, 'close');
    });

    ws.on('error', (err) => {
        console.error('WebSocket client error:', err);
        terminatePeer(ws, `socket_error:${err.code || err.message}`);
    });
});

// --- Server Start ---
const PORT = 8080;
server.listen(PORT, () => {
    console.log(`Server is listening on http://localhost:${PORT}`);
    startCapture(); // Initial start of the Capture process
});
