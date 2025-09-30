const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const sharp = require('sharp');
const express = require('express');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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

wss.on('connection', ws => {
    console.log('WebSocket client connected');
    ws.send(JSON.stringify({ type: 'integration_state', is_integrating: isIntegrating }));
    ws.send(JSON.stringify({ type: 'settings', ...channelSettings }));

    ws.on('message', message => {
        try {
            const msg = JSON.parse(message);

            if (msg.command) {
                if (msg.command === 'start_integration') {
                    isIntegrating = true;
                } else if (msg.command === 'stop_integration') {
                    isIntegrating = false;
                }

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msg));
                    }
                });

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'integration_state', is_integrating: isIntegrating }));
                    }
                });
            } else if (msg.type === 'lkfs') {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ loudness: msg.value }));
                    }
                });
            } else if (msg.type === 's_lkfs') {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ short_term_loudness: msg.value }));
                    }
                });
            } else if (msg.type === 'i_lkfs') {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ integrated_loudness: msg.value }));
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
                // Broadcast all other messages
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msg));
                    }
                });
            }
        } catch (e) {
            // console.error('Failed to parse WebSocket message:', e);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
    });
});

const PORT = 8080;
server.listen(PORT, () => {
    console.log(`Server is listening on http://localhost:${PORT}`);
    startCapture(); // Initial start of the Capture process
});