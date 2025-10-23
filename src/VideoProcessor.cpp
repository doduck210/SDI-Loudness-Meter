#include "VideoProcessor.h"
#include <iostream>
#include <libavutil/error.h>

// Helper function to map DeckLink pixel formats to FFmpeg pixel formats
static AVPixelFormat get_ffmpeg_pixel_format(BMDPixelFormat bmd_format) {
    switch (bmd_format) {
        case bmdFormat8BitYUV:
            return AV_PIX_FMT_UYVY422;
        case bmdFormat10BitYUV:
            return AV_PIX_FMT_Y210LE;
        // Add other formats if needed
        default:
            return AV_PIX_FMT_NONE;
    }
}

VideoProcessor::VideoProcessor() :
    initialized(false),
    swsContext(nullptr),
    sourcePixelFormat(AV_PIX_FMT_NONE),
    srcFrame(nullptr),
    dstFrame(nullptr),
    webrtc_handler(nullptr),
    raw_video_processor(nullptr),
    vector_scope_processor(nullptr) {
}

VideoProcessor::~VideoProcessor() {
    cleanup();
}

void VideoProcessor::cleanup() {
    // Processors are cleaned up by unique_ptr, but we can call cleanup explicitly if needed
    if (raw_video_processor) raw_video_processor->cleanup();
    if (vector_scope_processor) vector_scope_processor->cleanup();

    raw_video_processor.reset();
    vector_scope_processor.reset();
    webrtc_handler.reset();

    if (srcFrame) av_frame_free(&srcFrame);
    if (dstFrame) av_frame_free(&dstFrame);
    if (swsContext) sws_freeContext(swsContext);

    initialized = false;
    srcFrame = nullptr;
    dstFrame = nullptr;
    swsContext = nullptr;

    std::cerr << "VideoProcessor cleaned up." << std::endl;
}


bool VideoProcessor::initialize(int width, int height, BMDTimeValue timeScale, BMDTimeValue frameDuration, BMDPixelFormat pixelFormat) {
    cleanup();

    sourcePixelFormat = get_ffmpeg_pixel_format(pixelFormat);
    if (sourcePixelFormat == AV_PIX_FMT_NONE) {
        std::cerr << "Unsupported input pixel format for VideoProcessor." << std::endl;
        return false;
    }

    const int dst_width = 640;
    const int dst_height = 360;
    const AVRational time_base = {(int)frameDuration, (int)timeScale};
    const AVRational framerate = {(int)timeScale, (int)frameDuration};

    try {
        webrtc_handler = std::make_shared<WebRTC>("publisher");

        raw_video_processor = std::make_unique<RawVideoProcessor>();
        if (!raw_video_processor->initialize(dst_width, dst_height, time_base, framerate, webrtc_handler)) {
            throw std::runtime_error("Failed to initialize RawVideoProcessor.");
        }

        vector_scope_processor = std::make_unique<VideoVectorScope>();
        if (!vector_scope_processor->initialize(dst_width, dst_height, AV_PIX_FMT_YUV420P, time_base, framerate, webrtc_handler)) {
            std::cerr << "[Warning] Failed to initialize VideoVectorScope." << std::endl;
            vector_scope_processor.reset(); // Continue without vectorscope
        }

    } catch (const std::exception& e) {
        std::cerr << "Failed to initialize processing components: " << e.what() << std::endl;
        cleanup();
        return false;
    }

    swsContext = sws_getContext(width, height, sourcePixelFormat,
                                dst_width, dst_height, AV_PIX_FMT_YUV420P,
                                SWS_BILINEAR, NULL, NULL, NULL);
    if (!swsContext) { std::cerr << "Could not create scaling context." << std::endl; cleanup(); return false; }

    srcFrame = av_frame_alloc();
    dstFrame = av_frame_alloc();

    if (!srcFrame || !dstFrame) { std::cerr << "Could not allocate frame." << std::endl; cleanup(); return false; }

    dstFrame->width = dst_width;
    dstFrame->height = dst_height;
    dstFrame->format = AV_PIX_FMT_YUV420P;
    av_frame_get_buffer(dstFrame, 0);

    initialized = true;
    std::cerr << "VideoProcessor initialized for WebRTC streaming." << std::endl;
    return true;
}

void VideoProcessor::processFrame(IDeckLinkVideoInputFrame* frame) {
    if (!initialized || !frame || !swsContext) {
        return;
    }

    void* frameBytes;
    frame->GetBytes(&frameBytes);

    uint8_t* src_data[1] = { (uint8_t*)frameBytes };
    int src_linesize[1] = { (int)frame->GetRowBytes() };

    sws_scale(swsContext, src_data, src_linesize, 0, frame->GetHeight(), dstFrame->data, dstFrame->linesize);

    static int64_t pts = 0;
    dstFrame->pts = pts++;
    
    if (raw_video_processor) {
        raw_video_processor->process_frame(dstFrame);
    }

    if (vector_scope_processor) {
        vector_scope_processor->process_and_encode(dstFrame);
    }
}

void VideoProcessor::stop() {
    cleanup();
}