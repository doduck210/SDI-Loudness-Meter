# Video Frame Processing Pipeline

This document outlines the step-by-step flow of a single video frame through the application, from SDI capture to H.264 encoding.

### Step 1: Capture Initialization (`Capture.cpp`)

1.  The `main` function's `while` loop calls `EnableVideoInput`, configuring the DeckLink card to output the 8-bit YUV pixel format (`bmdFormat8BitYUV`) using the `-p 0` command-line option.
2.  Immediately after, `VideoProcessor::initialize` is called, passing the chosen pixel format to the processor so it knows what kind of data to expect.
3.  `StartStreams` is called, and the DeckLink hardware begins sending video frames.

### Step 2: Frame Arrival (`Capture.cpp`)

1.  The `DeckLinkCaptureDelegate::VideoInputFrameArrived` callback method is invoked by the DeckLink driver for each new frame.
2.  Inside this method, the `IDeckLinkVideoInputFrame* videoFrame` is passed to the video processor: `g_videoProcessor.processFrame(videoFrame, ...)`. 

### Step 3: Pixel Format Mapping (`VideoProcessor.cpp`)

1.  During initialization, `VideoProcessor` uses a helper function to map the `BMDPixelFormat` from the capture logic to a specific FFmpeg `AVPixelFormat`.
2.  The correct, working mapping is:
    - **8-bit YUV (`bmdFormat8BitYUV`)** → `AV_PIX_FMT_UYVY422`

### Step 4: Scaling (Color Space and Size Conversion)

1.  An FFmpeg `SwsContext` (scaler) is initialized to handle the conversion from the source format (`AV_PIX_FMT_UYVY422`) and resolution (e.g., 1920x1080) to the destination format (`AV_PIX_FMT_YUV420P`) and resolution (480x270).
2.  In `processFrame`, the raw data pointer and stride are retrieved from the `videoFrame` using `GetBytes()` and `GetRowBytes()`.
3.  `sws_scale` is called with these values. It correctly interprets the packed UYVY data and outputs a standard planar YUV420P frame, resolving all color and wrap-around issues.

### Step 5: H.264 Encoding

1.  The new 8-bit, 480x270 YUV420P frame produced by the scaler is passed to the `libx264` encoder via `avcodec_send_frame`.
2.  The encoder compresses the frame, and the resulting compressed data is retrieved in an `AVPacket` via `avcodec_receive_packet`.

### Step 6: Output

1.  The compressed `AVPacket` is written to the `output.mp4` container file using `av_interleaved_write_frame`.
2.  At program termination, `av_write_trailer` is called to finalize the MP4 file, making it playable.
