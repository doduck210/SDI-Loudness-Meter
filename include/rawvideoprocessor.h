#pragma once

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/imgutils.h>
#include <libavutil/error.h>
}
#include "WebRTC.h"
#include <memory>
#include <iostream>
#include <stdexcept>

class RawVideoProcessor {
public:
    RawVideoProcessor() = default;
    ~RawVideoProcessor() {
        cleanup();
    }

    bool initialize(int width, int height, AVRational time_base, AVRational framerate, std::shared_ptr<WebRTC> handler) {
        cleanup();
        webrtc_handler = handler;

        const AVCodec* codec = avcodec_find_encoder_by_name("libx264");
        if (!codec) { std::cerr << "Codec libx264 not found." << std::endl; return false; }

        codecContext = avcodec_alloc_context3(codec);
        if (!codecContext) { std::cerr << "Could not allocate video codec context." << std::endl; return false; }

        codecContext->bit_rate = 4000000;
        codecContext->width = width;
        codecContext->height = height;
        codecContext->time_base = time_base;
        codecContext->framerate = framerate;
        codecContext->gop_size = 30;
        codecContext->max_b_frames = 0;
        codecContext->pix_fmt = AV_PIX_FMT_YUV420P;
        codecContext->profile = FF_PROFILE_H264_MAIN;
        codecContext->level = 31;

        av_opt_set(codecContext->priv_data, "preset", "ultrafast", 0);
        av_opt_set(codecContext->priv_data, "tune", "zerolatency", 0);
        av_opt_set(codecContext->priv_data, "x264-params", "repeat-headers=1", 0);

        if (avcodec_open2(codecContext, codec, NULL) < 0) { std::cerr << "Could not open codec." << std::endl; return false; }

        packet = av_packet_alloc();
        if (!packet) { std::cerr << "Could not allocate packet." << std::endl; return false; }

        webrtc_handler->RegisterH264Track("video-raw", "stream-raw", "video-raw", 43);
        initialized = true;
        return true;
    }

    void process_frame(const AVFrame* frame) {
        if (!initialized) return;

        int send_ret = avcodec_send_frame(codecContext, frame);
        if (send_ret >= 0) {
            while (true) {
                int recv_ret = avcodec_receive_packet(codecContext, packet);
                if (recv_ret == AVERROR(EAGAIN) || recv_ret == AVERROR_EOF) {
                    break;
                } else if (recv_ret < 0) {
                    char errStr[AV_ERROR_MAX_STRING_SIZE] = {0};
                    av_make_error_string(errStr, AV_ERROR_MAX_STRING_SIZE, recv_ret);
                    fprintf(stderr, "[FFmpeg] Error during encoding: avcodec_receive_packet failed with error %s\n", errStr);
                    break;
                }

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

    void cleanup() {
        if (codecContext) avcodec_free_context(&codecContext);
        if (packet) av_packet_free(&packet);
        codecContext = nullptr;
        packet = nullptr;
        webrtc_handler = nullptr;
        initialized = false;
    }

private:
    AVCodecContext* codecContext = nullptr;
    AVPacket* packet = nullptr;
    std::shared_ptr<WebRTC> webrtc_handler = nullptr;
    bool initialized = false;
};
