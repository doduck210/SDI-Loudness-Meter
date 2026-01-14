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
let latestSignalInfo = null;

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
const statsWorker = fork(path.join(__dirname, 'web', 'statsWorker.js'));

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
    const { leftChannel, rightChannel, device, mode } = req.body;
    let shouldRestart = false;

    if (leftChannel !== undefined && rightChannel !== undefined) {
        channelSettings.leftAudioChannel = parseInt(leftChannel, 10);
        channelSettings.rightAudioChannel = parseInt(rightChannel, 10);
        shouldRestart = true;
    }

    if (device !== undefined) {
        channelSettings.device = parseInt(device, 10);
        shouldRestart = true;
    }

    if (mode !== undefined) {
        channelSettings.mode = parseInt(mode, 10);
        shouldRestart = true;
    }

    if (!shouldRestart) {
        res.status(400).json({ success: false, message: 'Invalid settings provided.' });
        return;
    }

    console.log('Updated channel settings:', channelSettings);
    startCapture(); // Restart capture process with new settings
    res.json({ success: true, message: 'Settings updated and Capture process restarted.' });
});

const DEVICE_CONFIGURE_PATH = path.join(__dirname, 'tools', 'deviceconfigure', 'DeviceConfigure');

function runDeviceConfigure(args, options = {}) {
    const { allowNonZero = false } = options;
    return new Promise((resolve, reject) => {
        const proc = spawn(DEVICE_CONFIGURE_PATH, args);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('error', (err) => {
            reject(err);
        });

        proc.on('close', (code) => {
            if (code !== 0 && !allowNonZero) {
                reject(new Error(`DeviceConfigure exited with code ${code}: ${stderr}`));
                return;
            }
            resolve({ stdout, stderr, code });
        });
    });
}

function parseDeviceList(output) {
    const lines = output.split(/\r?\n/);
    const devices = [];
    let inDeviceList = false;

    for (const line of lines) {
        if (line.includes('-d <device id>:')) {
            inDeviceList = true;
            continue;
        }
        if (inDeviceList) {
            if (line.trim().startsWith('-') || line.includes('Options:')) {
                break;
            }
            const match = line.match(/^\s[* ]?\s*(\d+):\s+(.*)$/);
            if (match) {
                devices.push({ id: Number(match[1]), name: match[2].trim() });
            }
        }
    }
    return devices;
}

function parseConnectorOptions(lines, startLabel) {
    const options = [];
    let inSection = false;

    for (const line of lines) {
        if (line.includes(startLabel)) {
            inSection = true;
            continue;
        }
        if (inSection && line.trim().startsWith('-')) {
            break;
        }
        if (!inSection) continue;
        const match = line.match(/^\s*([* ])\s*(\d+):\s+(.*)$/);
        if (match) {
            options.push({
                id: Number(match[2]),
                label: match[3].trim(),
                selected: match[1] === '*'
            });
        }
    }

    return options;
}

app.get('/api/input-config/devices', async (_req, res) => {
    try {
        const { stdout, stderr } = await runDeviceConfigure(['-h'], { allowNonZero: true });
        const output = `${stdout}\n${stderr}`;
        res.json({ devices: parseDeviceList(output) });
    } catch (err) {
        console.error('Failed to load DeviceConfigure devices:', err);
        res.status(500).json({ success: false, message: 'Failed to load devices.' });
    }
});

app.get('/api/input-config/options', async (req, res) => {
    const device = req.query.device;
    if (device === undefined) {
        res.status(400).json({ success: false, message: 'Missing device.' });
        return;
    }
    try {
        const { stdout, stderr } = await runDeviceConfigure(['-d', String(device), '-h'], { allowNonZero: true });
        const output = `${stdout}\n${stderr}`;
        const lines = output.split(/\r?\n/);
        const videoInputs = parseConnectorOptions(lines, '-v <video input connector id>');
        const audioInputs = parseConnectorOptions(lines, '-a <audio input connector id>');
        res.json({ videoInputs, audioInputs });
    } catch (err) {
        console.error('Failed to load DeviceConfigure options:', err);
        res.status(500).json({ success: false, message: 'Failed to load options.' });
    }
});

app.post('/api/input-config/apply', async (req, res) => {
    const { device, videoInputId, audioInputId } = req.body;
    if (device === undefined) {
        res.status(400).json({ success: false, message: 'Missing device.' });
        return;
    }
    const args = ['-d', String(device)];
    if (videoInputId !== undefined && videoInputId !== null && videoInputId !== '') {
        args.push('-v', String(videoInputId));
    }
    if (audioInputId !== undefined && audioInputId !== null && audioInputId !== '') {
        args.push('-a', String(audioInputId));
    }

    try {
        await runDeviceConfigure(args);
        res.json({ success: true, message: 'Device configuration updated.' });
    } catch (err) {
        console.error('Failed to apply DeviceConfigure settings:', err);
        res.status(500).json({ success: false, message: 'Failed to apply configuration.' });
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
    if (latestSignalInfo) {
        ws.send(latestSignalInfo);
    }

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
        } else if (msg.type === 'signal_info') {
            const msgStr = JSON.stringify(msg);
            latestSignalInfo = msgStr;
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(msgStr);
                }
            });
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
