# Video Frame Processing for WebRTC Streaming

### Step 1: Initialization (`VideoProcessor::initialize`)

1.  **Pixel Format Mapping**: The incoming `BMDPixelFormat` from the DeckLink card (e.g., `bmdFormat8BitYUV`) is mapped to its corresponding FFmpeg `AVPixelFormat` (e.g., `AV_PIX_FMT_UYVY422`).
2.  **Encoder Configuration**: The `libx264` H.264 encoder is loaded. Its `AVCodecContext` is configured for real-time streaming with an `ultrafast` preset and `zerolatency` tune. The `repeat-headers=1` option is also set to ensure compatibility with WebRTC clients.
3.  **WebRTC Handler**: A `WebRTC` handler object is created, and an H.264 video track is registered with it. This prepares the connection for sending the encoded video data.
4.  **Scaler Setup**: An FFmpeg `SwsContext` (scaler) is initialized. It's configured to convert the source video (e.g., 1920x1080, `AV_PIX_FMT_UYVY422`) into the destination format required by the encoder (640x360, `AV_PIX_FMT_YUV420P`).
5.  **Resource Allocation**: `AVFrame` and `AVPacket` objects are allocated to hold the scaled video data and the final encoded output.

### Step 2: Frame Processing (`VideoProcessor::processFrame`)

1.  **Frame Arrival**: The `processFrame` method is called with a new `IDeckLinkVideoInputFrame` from the capture delegate.
2.  **Scaling and Color Conversion**: The raw video data from the DeckLink frame is passed to `sws_scale`. This function performs both the resizing (e.g., from HD to 640x360) and the pixel format conversion (e.g., UYVY to planar YUV420P), writing the result into the destination `AVFrame`.
3.  **Encoding Input**: The processed, scaled frame is sent to the `libx264` encoder using `avcodec_send_frame`.

### Step 3: H.264 Encoding and WebRTC Streaming

1.  **Receive Packet**: The application enters a loop calling `avcodec_receive_packet` to retrieve any available compressed data from the encoder. A single input frame can result in one or more output packets.
2.  **Send via WebRTC**: Each resulting `AVPacket`, which contains a piece of the H.264 stream, is immediately passed to the `webrtc_handler->SendEncoded(...)` method.
3.  **Live Stream**: The WebRTC handler is responsible for packaging the H.264 data into RTP packets and sending them over its peer connection to the connected web browser, enabling a live video feed.

### Step 4: Cleanup

When the processor is stopped or destroyed, the `cleanup` function is called to release all allocated resources. This includes freeing the `AVCodecContext`, `AVFrame`s, `AVPacket`, `SwsContext`, and shutting down the `WebRTC` handler.

---

# WebRTC 스트리밍을 위한 비디오 프레임 처리

### 1단계: 초기화 (`VideoProcessor::initialize`)

1.  **픽셀 포맷 매핑**: DeckLink 카드에서 들어오는 `BMDPixelFormat`(예: `bmdFormat8BitYUV`)을 그에 상응하는 FFmpeg `AVPixelFormat`(예: `AV_PIX_FMT_UYVY422`)으로 매핑한다.
2.  **인코더 설정**: `libx264` H.264 인코더를 로드한다. `AVCodecContext`는 `ultrafast` 프리셋과 `zerolatency` 튠으로 실시간 스트리밍에 최적화되도록 설정한다. 또한 `repeat-headers=1` 옵션을 설정하여 WebRTC 클라이언트와의 호환성을 보장한다.
3.  **WebRTC 핸들러**: `WebRTC` 핸들러 객체를 생성하고 H.264 비디오 트랙을 등록한다. 이를 통해 인코딩된 비디오 데이터를 보낼 준비를 한다.
4.  **스케일러 설정**: FFmpeg `SwsContext`(스케일러)를 초기화한다. 소스 비디오(예: 1920x1080, `AV_PIX_FMT_UYVY422`)를 인코더에 필요한 목적지 포맷(640x360, `AV_PIX_FMT_YUV420P`)으로 변환하도록 설정한다.
5.  **리소스 할당**: 스케일링된 비디오 데이터와 최종 인코딩된 출력을 담을 `AVFrame` 및 `AVPacket` 객체를 할당한다.

### 2단계: 프레임 처리 (`VideoProcessor::processFrame`)

1.  **프레임 도착**: 캡처 델리게이트로부터 새로운 `IDeckLinkVideoInputFrame`과 함께 `processFrame` 메소드가 호출된다.
2.  **스케일링 및 색상 변환**: DeckLink 프레임의 원본 비디오 데이터를 `sws_scale`에 전달한다. 이 함수는 리사이징(예: HD에서 640x360으로)과 픽셀 포맷 변환(예: UYVY에서 평면 YUV420P로)을 모두 수행하고, 그 결과를 목적지 `AVFrame`에 기록한다.
3.  **인코딩 입력**: 처리 및 스케일링된 프레임을 `avcodec_send_frame`을 사용하여 `libx264` 인코더로 보낸다.

### 3단계: H.264 인코딩 및 WebRTC 스트리밍

1.  **패킷 수신**: 애플리케이션은 `avcodec_receive_packet`을 호출하는 루프에 진입하여 인코더에서 사용 가능한 압축 데이터를 검색한다. 하나의 입력 프레임은 하나 이상의 출력 패킷을 생성할 수 있다.
2.  **WebRTC를 통해 전송**: H.264 스트림의 일부를 포함하는 각각의 `AVPacket`은 즉시 `webrtc_handler->SendEncoded(...)` 메소드로 전달된다.
3.  **라이브 스트림**: WebRTC 핸들러는 H.264 데이터를 RTP 패킷으로 패키징하고 피어 커넥션을 통해 연결된 웹 브라우저로 전송하여 라이브 비디오 피드를 가능하게 하는 역할을 담당한다.

### 4단계: 정리

프로세서가 중지되거나 소멸될 때, 할당된 모든 리소스를 해제하기 위해 `cleanup` 함수가 호출된다. 여기에는 `AVCodecContext`, `AVFrame`, `AVPacket`, `SwsContext`를 해제하고 `WebRTC` 핸들러를 종료하는 작업이 포함된다.