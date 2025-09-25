#include "VideoProcessor.h"
#include <iostream>

const char* output_filename = "output.mp4";

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
    formatContext(nullptr),
    srcFrame(nullptr),
    dstFrame(nullptr),
    packet(nullptr),
    swsContext(nullptr),
    sourcePixelFormat(AV_PIX_FMT_NONE) {
}

VideoProcessor::~VideoProcessor() {
    cleanup();
}

void VideoProcessor::cleanup() {
    if (initialized) {
        if (formatContext) {
            av_write_trailer(formatContext);
        }
    }

    if (codecContext) avcodec_free_context(&codecContext);
    if (formatContext) {
        if (!(formatContext->oformat->flags & AVFMT_NOFILE)) {
            avio_closep(&formatContext->pb);
        }
        avformat_free_context(formatContext);
    }
    if (srcFrame) av_frame_free(&srcFrame);
    if (dstFrame) av_frame_free(&dstFrame);
    if (packet) av_packet_free(&packet);
    if (swsContext) sws_freeContext(swsContext);

    initialized = false;
    codecContext = nullptr;
    formatContext = nullptr;
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

    const int dst_width = 480;
    const int dst_height = 270;

    avformat_alloc_output_context2(&formatContext, NULL, NULL, output_filename);
    if (!formatContext) { std::cerr << "Could not create output context" << std::endl; return false; }

    const AVCodec* codec = avcodec_find_encoder_by_name("libx264");
    if (!codec) { std::cerr << "Codec libx264 not found." << std::endl; return false; }

    AVStream* stream = avformat_new_stream(formatContext, codec);
    if (!stream) { std::cerr << "Failed allocating output stream" << std::endl; return false; }

    codecContext = avcodec_alloc_context3(codec);
    if (!codecContext) { std::cerr << "Could not allocate video codec context." << std::endl; return false; }

    codecContext->bit_rate = 400000;
    codecContext->width = dst_width;
    codecContext->height = dst_height;
    stream->time_base = (AVRational){(int)frameDuration, (int)timeScale};
    codecContext->time_base = stream->time_base;
    codecContext->framerate = (AVRational){(int)timeScale, (int)frameDuration};
    codecContext->gop_size = 10;
    codecContext->max_b_frames = 1;
    codecContext->pix_fmt = AV_PIX_FMT_YUV420P;

    av_opt_set(codecContext->priv_data, "preset", "ultrafast", 0);
    av_opt_set(codecContext->priv_data, "tune", "zerolatency", 0);

    if (avcodec_open2(codecContext, codec, NULL) < 0) { std::cerr << "Could not open codec." << std::endl; return false; }

    avcodec_parameters_from_context(stream->codecpar, codecContext);

    if (!(formatContext->oformat->flags & AVFMT_NOFILE)) {
        if (avio_open(&formatContext->pb, output_filename, AVIO_FLAG_WRITE) < 0) { std::cerr << "Could not open output file " << output_filename << std::endl; return false; }
    }

    if (avformat_write_header(formatContext, NULL) < 0) { std::cerr << "Error occurred when opening output file" << std::endl; return false; }

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
    std::cerr << "VideoProcessor initialized. Encoding to " << output_filename << std::endl;
    return true;
}

void VideoProcessor::processFrame(IDeckLinkVideoInputFrame* frame, const std::function<void(const std::string&)>& send_ws_message) {
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

    if (avcodec_send_frame(codecContext, dstFrame) >= 0) {
        while (avcodec_receive_packet(codecContext, packet) >= 0) {
            av_packet_rescale_ts(packet, codecContext->time_base, formatContext->streams[0]->time_base);
            packet->stream_index = 0;

            if (av_interleaved_write_frame(formatContext, packet) < 0) {
                std::cerr << "Error writing frame to file" << std::endl;
            }
            av_packet_unref(packet);
        }
    }
}

void VideoProcessor::stop() {
    cleanup();
}