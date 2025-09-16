const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const sharp = require('sharp');

const mjpegClients = new Set();

// 1. HTTP 서버 생성
const server = http.createServer((req, res) => {
    if (req.url === '/vectorscope.mjpeg') {
        // MJPEG 스트림 요청 처리
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=--frame',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
            'Pragma': 'no-cache'
        });
        mjpegClients.add(res); // 클라이언트 리스트에 추가
        console.log(`MJPEG stream client connected. Total clients: ${mjpegClients.size}`);

        req.on('close', () => {
            mjpegClients.delete(res); // 연결 종료 시 클라이언트 제거
            console.log(`MJPEG stream client disconnected. Total clients: ${mjpegClients.size}`);
        });

    } else {
        // index.html 파일 제공
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data);
        });
    }
});

// 2. WebSocket 서버 생성
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
    console.log('WebSocket client connected');

    ws.on('message', message => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'lkfs') {
                // LKFS 값을 모든 웹소켓 클라이언트에게 브로드캐스트 (C++ 클라이언트 포함)
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ loudness: msg.value }));
                    }
                });
            } else if (msg.type === 'vectorscope' && msg.data) {
                const ppmFrame = Buffer.from(msg.data, 'base64');
                
                // PPM 헤더에서 width/height를 간단히 파싱 (더 견고한 파서가 필요할 수 있음)
                const headerMatch = ppmFrame.toString('ascii', 0, 30).match(/P6\n(\d+)\s(\d+)\n255\n/);
                if (!headerMatch) return;

                const width = parseInt(headerMatch[1], 10);
                const height = parseInt(headerMatch[2], 10);

                // PPM을 JPEG으로 변환
                sharp(ppmFrame, { raw: { width, height, channels: 3 } })
                    .jpeg()
                    .toBuffer()
                    .then(jpegFrame => {
                        // 모든 MJPEG 클라이언트에게 프레임 전송
                        mjpegClients.forEach(client => {
                            client.write('--frame\r\n');
                            client.write('Content-Type: image/jpeg\r\n');
                            client.write(`Content-Length: ${jpegFrame.length}\r\n`);
                            client.write('\r\n');
                            client.write(jpegFrame);
                            client.write('\r\n');
                        });
                    })
                    .catch(err => {
                        // console.error('Error converting PPM to JPEG:', err);
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

// 3. 서버 시작
const PORT = 8080;
server.listen(PORT, () => {
    console.log(`Server is listening on http://localhost:${PORT}`);
    console.log('Ready for C++ application to connect.');
});
