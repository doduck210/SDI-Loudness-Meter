const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const sharp = require('sharp');

const clients = new Set();

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
        clients.add(res); // 클라이언트 리스트에 추가
        console.log(`MJPEG stream client connected. Total clients: ${clients.size}`);

        req.on('close', () => {
            clients.delete(res); // 연결 종료 시 클라이언트 제거
            console.log(`MJPEG stream client disconnected. Total clients: ${clients.size}`);
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
    ws.on('close', () => {
        console.log('WebSocket client disconnected');
    });
});

// 3. C++ 프로그램 실행
const captureProcess = spawn('./Capture', ['-d', '0', '-m', '11']);

// 4. C++ 프로그램의 표준 에러(stderr)에서 라우드니스 값 읽기
captureProcess.stderr.on('data', data => {
    const dataStr = data.toString();
    // stderr 데이터는 여러 줄일 수 있으므로 각 줄을 처리
    dataStr.split('\n').forEach(line => {
        if (line) {
            const loudnessValue = parseFloat(line);
            if (!isNaN(loudnessValue)) {
                // 모든 웹소켓 클라이언트에게 라우드니스 값 브로드캐스트
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ loudness: loudnessValue }));
                    }
                });
            }
        }
    });
});

// 5. C++ 프로그램의 표준 출력(stdout)에서 PPM 데이터 읽고 MJPEG 스트림으로 전송
let ppmParser = createPpmParser();
captureProcess.stdout.on('data', (chunk) => {
    ppmParser(chunk);
});

function createPpmParser() {
    let buffer = Buffer.alloc(0);
    let state = 'HEADER_P';
    let width = 0, height = 0;
    let header = '';

    return function parse(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            if (state === 'HEADER_P') {
                if (buffer.length < 3) return;
                if (buffer.toString('ascii', 0, 3) !== 'P6\n') {
                    console.error('Not a PPM stream');
                    return;
                }
                buffer = buffer.slice(3);
                state = 'HEADER_DIMS';
                header = '';
            }
            if (state === 'HEADER_DIMS') {
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex === -1) return; // Need more data
                const dimsLine = buffer.slice(0, newlineIndex).toString('ascii');
                header += dimsLine + '\n';
                const dims = dimsLine.split(' ');
                width = parseInt(dims[0], 10);
                height = parseInt(dims[1], 10);
                buffer = buffer.slice(newlineIndex + 1);
                state = 'HEADER_MAXVAL';
            }
            if (state === 'HEADER_MAXVAL') {
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex === -1) return; // Need more data
                header += buffer.slice(0, newlineIndex + 1).toString('ascii');
                buffer = buffer.slice(newlineIndex + 1);
                state = 'BODY';
            }
            if (state === 'BODY') {
                const frameSize = width * height * 3;
                if (buffer.length < frameSize) return; // Need more data

                const ppmFrame = Buffer.concat([Buffer.from(header, 'ascii'), buffer.slice(0, frameSize)]);
                buffer = buffer.slice(frameSize);
                state = 'HEADER_P'; // Reset for next frame

                // PPM을 JPEG으로 변환
                sharp(ppmFrame, { raw: { width, height, channels: 3 } })
                    .jpeg()
                    .toBuffer()
                    .then(jpegFrame => {
                        // 모든 MJPEG 클라이언트에게 프레임 전송
                        clients.forEach(client => {
                            client.write('--frame\r\n');
                            client.write('Content-Type: image/jpeg\r\n');
                            client.write(`Content-Length: ${jpegFrame.length}\r\n`);
                            client.write('\r\n');
                            client.write(jpegFrame);
                            client.write('\r\n');
                        });
                    })
                    .catch(err => {
                        console.error('Error converting PPM to JPEG:', err);
                    });
            }
        }
    };
}

captureProcess.on('close', code => {
    console.log(`Capture process exited with code ${code}`);
    // 모든 MJPEG 클라이언트 연결 종료
    clients.forEach(client => client.end());
});

// 6. 서버 시작
const PORT = 8080;
server.listen(PORT, () => {
    console.log(`Server is listening on http://localhost:${PORT}`);
    console.log('Starting Capture process...');
});