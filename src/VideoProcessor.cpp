#include "VideoProcessor.h"
#include <iostream>
#include <libavutil/error.h>

// const char* output_filename = "output.mp4"; // No longer needed

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
    codecContext(nullptr),
    formatContext(nullptr), // Will not be used, but keep for now to avoid breaking constructor
    srcFrame(nullptr),
    dstFrame(nullptr),
    packet(nullptr),
    swsContext(nullptr),
    sourcePixelFormat(AV_PIX_FMT_NONE),
    webrtc_handler(nullptr) {
}

VideoProcessor::~VideoProcessor() {
    cleanup();
}

void VideoProcessor::cleanup() {
    // No need to write trailer to file
    // if (initialized && formatContext) {
    //     av_write_trailer(formatContext);
    // }

    webrtc_handler.reset();

    if (codecContext) avcodec_free_context(&codecContext);
    
    // formatContext is not used for WebRTC
    if (formatContext) {
        // if (!(formatContext->oformat->flags & AVFMT_NOFILE)) {
        //     avio_closep(&formatContext->pb);
        // }
        avformat_free_context(formatContext);
        formatContext = nullptr;
    }

    if (srcFrame) av_frame_free(&srcFrame);
    if (dstFrame) av_frame_free(&dstFrame);
    if (packet) av_packet_free(&packet);
    if (swsContext) sws_freeContext(swsContext);

    initialized = false;
    codecContext = nullptr;
    srcFrame = nullptr;
    dstFrame = nullptr;
    packet = nullptr;
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

    // avformat_alloc_output_context2(&formatContext, NULL, NULL, output_filename); // REMOVED
    // if (!formatContext) { std::cerr << "Could not create output context" << std::endl; return false; }

    const AVCodec* codec = avcodec_find_encoder_by_name("libx264");
    if (!codec) { std::cerr << "Codec libx264 not found." << std::endl; return false; }

    // AVStream* stream = avformat_new_stream(formatContext, codec); // REMOVED
    // if (!stream) { std::cerr << "Failed allocating output stream" << std::endl; return false; }

    codecContext = avcodec_alloc_context3(codec);
    if (!codecContext) { std::cerr << "Could not allocate video codec context." << std::endl; return false; }

    // Settings matched to the example's VideoEncoder.h for similar quality/performance
    codecContext->bit_rate = 4000000; // 4 Mbps
    codecContext->width = dst_width;
    codecContext->height = dst_height;
    codecContext->time_base = (AVRational){(int)frameDuration, (int)timeScale}; // Use source timebase
    codecContext->framerate = (AVRational){(int)timeScale, (int)frameDuration}; // Use source framerate
    codecContext->gop_size = 30; // GOP size of 30
    codecContext->max_b_frames = 0; // No B-frames
    codecContext->pix_fmt = AV_PIX_FMT_YUV420P;
    codecContext->profile = FF_PROFILE_H264_MAIN; // H.264 Main Profile
    codecContext->level = 31; // H.264 Level 3.1

    av_opt_set(codecContext->priv_data, "preset", "ultrafast", 0);
    av_opt_set(codecContext->priv_data, "tune", "zerolatency", 0);
    
    // Repeat SPS/PPS headers for WebRTC compatibility
    av_opt_set(codecContext->priv_data, "x264-params", "repeat-headers=1", 0);

    if (avcodec_open2(codecContext, codec, NULL) < 0) { std::cerr << "Could not open codec." << std::endl; return false; }

    // avcodec_parameters_from_context(stream->codecpar, codecContext); // REMOVED

    // File I/O related calls REMOVED
    // if (!(formatContext->oformat->flags & AVFMT_NOFILE)) {
    //     if (avio_open(&formatContext->pb, output_filename, AVIO_FLAG_WRITE) < 0) { std::cerr << "Could not open output file " << output_filename << std::endl; return false; }
    // }
    // if (avformat_write_header(formatContext, NULL) < 0) { std::cerr << "Error occurred when opening output file" << std::endl; return false; }

    try {
        webrtc_handler = std::make_shared<WebRTC>("publisher");
        webrtc_handler->RegisterH264Track("video-raw", "stream-raw", "video-raw", 43);
    } catch (const std::exception& e) {
        std::cerr << "Failed to initialize WebRTC: " << e.what() << std::endl;
        return false;
    }

    swsContext = sws_getContext(width, height, sourcePixelFormat,
                                dst_width, dst_height, AV_PIX_FMT_YUV420P,
                                SWS_BILINEAR, NULL, NULL, NULL);
    if (!swsContext) { std::cerr << "Could not create scaling context." << std::endl; return false; }

    srcFrame = av_frame_alloc();
    dstFrame = av_frame_alloc();
    packet = av_packet_alloc();

    if (!srcFrame || !dstFrame || !packet) { std::cerr << "Could not allocate frame or packet." << std::endl; return false; }

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

    int send_ret = avcodec_send_frame(codecContext, dstFrame);
    if (send_ret >= 0) {
        // fprintf(stderr, "[FFmpeg] avcodec_send_frame success\n");
        while (true) {
            int recv_ret = avcodec_receive_packet(codecContext, packet);
            if (recv_ret == AVERROR(EAGAIN) || recv_ret == AVERROR_EOF) {
                // fprintf(stderr, "[FFmpeg] avcodec_receive_packet returned EAGAIN or EOF\n");
                break;
            } else if (recv_ret < 0) {
                char errStr[AV_ERROR_MAX_STRING_SIZE] = {0};
                av_make_error_string(errStr, AV_ERROR_MAX_STRING_SIZE, recv_ret);
                fprintf(stderr, "[FFmpeg] Error during encoding: avcodec_receive_packet failed with error %s\n", errStr);
                break;
            }

            // fprintf(stderr, "[WebRTC] Encoding complete, packet size: %d\n", packet->size);
            if (webrtc_handler) {
                webrtc_handler->SendEncoded("video-raw", packet);
            }
            
            av_packet_unref(packet);
        }
    } else {
        char errStr[AV_ERROR_MAX_STRING_SIZE] = {0};
        av_make_error_string(errStr, AV_ERROR_MAX_STRING_SIZE, send_ret);
        fprintf(stderr, "[FFmpeg] Error sending frame for encoding: avcodec_send_frame failed with error %s\n", errStr);
    }
}

void VideoProcessor::stop() {
    cleanup();
}