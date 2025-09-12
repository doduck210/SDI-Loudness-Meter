
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// 1. HTTP 서버 생성 (index.html 파일 제공)
const server = http.createServer((req, res) => {
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
});

// 2. WebSocket 서버 생성 (HTTP 서버에 연결)
const wss = new WebSocket.Server({ server });

// 3. C++ 프로그램 실행
//    Makefile에 정의된 실행 파일 이름(예: SDILoudnessMeter)으로 변경해야 할 수 있습니다.
const sdiProcess = spawn('./Capture', ['-d', '0', '-m', '11']);

// 4. WebSocket 연결 처리
wss.on('connection', ws => {
    console.log('Client connected');
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

// 5. C++ 프로그램의 표준 출력(stdout)을 읽어 WebSocket 클라이언트에 전송
sdiProcess.stdout.on('data', data => {
    const dataStr = data.toString();
    console.log(`[Capture STDOUT]: ${dataStr.trim()}`); // C++ 프로그램의 원본 출력을 확인하기 위한 로그

    const loudnessValue = parseFloat(dataStr);
    if (!isNaN(loudnessValue)) {
        // 모든 연결된 클라이언트에게 라우드니스 값 브로드캐스트
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ loudness: loudnessValue }));
            }
        });
    }
});

// 6. C++ 프로그램의 표준 에러(stderr) 출력
sdiProcess.stderr.on('data', data => {
    console.error(`[SDILoudnessMeter STDERR]: ${data}`);
});

sdiProcess.on('close', code => {
    console.log(`SDILoudnessMeter process exited with code ${code}`);
});

// 7. 서버 시작
const PORT = 8080;
server.listen(PORT, () => {
    console.log(`Server is listening on http://localhost:${PORT}`);
    console.log('Starting SDILoudnessMeter process...');
});
