#pragma once

extern "C" {
#include <libavutil/avutil.h>
#include <libavutil/opt.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/frame.h>
#include <libavutil/error.h>
#include <libavcodec/avcodec.h>
}

#include <stdexcept>
#include <string>
#include <iostream>
#include <memory>
#include "WebRTC.h"

class VideoWaveform {
public:
    VideoWaveform() = default;
    ~VideoWaveform() {
        cleanup();
    }

    bool initialize(int width, int height, AVPixelFormat pix_fmt, AVRational time_base, AVRational frame_rate, std::shared_ptr<WebRTC> handler) {
        cleanup();
        webrtc_handler = handler;

        const int output_width = 1280;
        const int output_height = 720;

        // 1. Initialize filter graph
        filter_graph = avfilter_graph_alloc();
        if (!filter_graph) {
            std::cerr << "Failed to allocate filter graph" << std::endl;
            return false;
        }

        const AVFilter* buffersrc = avfilter_get_by_name("buffer");
        const AVFilter* buffersink = avfilter_get_by_name("buffersink");
        if (!buffersrc || !buffersink) {
            std::cerr << "Failed to find required buffer filters" << std::endl;
            return false;
        }

        char args[512];
        snprintf(args, sizeof(args),
            "video_size=%dx%d:pix_fmt=%d:time_base=%d/%d:frame_rate=%d/%d:pixel_aspect=1/1",
            width, height, pix_fmt, time_base.num, time_base.den, frame_rate.num, frame_rate.den);

        int ret = avfilter_graph_create_filter(&buffersrc_ctx, buffersrc, "in", args, nullptr, filter_graph);
        if (ret < 0) { std::cerr << "Failed to create buffer source" << std::endl; return false; }

        ret = avfilter_graph_create_filter(&buffersink_ctx, buffersink, "out", nullptr, nullptr, filter_graph);
        if (ret < 0) { std::cerr << "Failed to create buffer sink" << std::endl; return false; }

        AVFilterInOut* outputs = avfilter_inout_alloc();
        AVFilterInOut* inputs = avfilter_inout_alloc();
        outputs->name = av_strdup("in");
        outputs->filter_ctx = buffersrc_ctx;
        outputs->pad_idx = 0;
        outputs->next = nullptr;
        inputs->name = av_strdup("out");
        inputs->filter_ctx = buffersink_ctx;
        inputs->pad_idx = 0;
        inputs->next = nullptr;

        const char* filter_desc = 
            "waveform=i=0.04:g=green:fl=numbers,scale=1280:720,"
            "format=pix_fmts=yuv420p";
        ret = avfilter_graph_parse_ptr(filter_graph, filter_desc, &inputs, &outputs, nullptr);
        if (ret < 0) { std::cerr << "Failed to parse filter graph" << std::endl; return false; }

        ret = avfilter_graph_config(filter_graph, nullptr);
        if (ret < 0) { std::cerr << "Failed to configure filter graph" << std::endl; return false; }
        
        avfilter_inout_free(&inputs);
        avfilter_inout_free(&outputs);

        // 2. Initialize encoder
        const AVCodec* codec = avcodec_find_encoder_by_name("libx264");
        if (!codec) { std::cerr << "libx264 not found for waveform." << std::endl; return false; }

        codecContext = avcodec_alloc_context3(codec);
        if (!codecContext) { std::cerr << "Could not allocate waveform codec context." << std::endl; return false; }

        codecContext->bit_rate = 3'000'000;
        codecContext->width = output_width;
        codecContext->height = output_height;
        codecContext->time_base = time_base;
        codecContext->framerate = frame_rate;
        codecContext->gop_size = 30;
        codecContext->max_b_frames = 0;
        codecContext->pix_fmt = AV_PIX_FMT_YUV420P;
        codecContext->profile = FF_PROFILE_H264_BASELINE;
        codecContext->level = 31;

        av_opt_set(codecContext->priv_data, "preset", "ultrafast", 0);
        av_opt_set(codecContext->priv_data, "tune", "zerolatency", 0);
        av_opt_set(codecContext->priv_data, "x264-params", "repeat-headers=1", 0);

        if (avcodec_open2(codecContext, codec, NULL) < 0) { std::cerr << "Could not open waveform codec." << std::endl; return false; }

        // 3. Allocate frames and packet
        scopeFrame = av_frame_alloc();
        if (!scopeFrame) { std::cerr << "Could not allocate waveform frame." << std::endl; return false; }
        scopeFrame->width = output_width;
        scopeFrame->height = output_height;
        scopeFrame->format = AV_PIX_FMT_YUV420P;
        av_frame_get_buffer(scopeFrame, 0);

        packet = av_packet_alloc();
        if (!packet) { std::cerr << "Could not allocate packet." << std::endl; return false; }

        // 4. Register WebRTC track
        webrtc_handler->RegisterH264Track("video-wf","stream-waveform","video-wf", 45);
        std::cerr << "[Info] VideoWaveform initialized successfully." << std::endl;
        initialized = true;
        return true;
    }

    void process_and_encode(const AVFrame* in_frame) {
        if (!initialized) return;

        // 1. Filter the frame
        if (filter_frame(in_frame, scopeFrame)) {
            scopeFrame->pts = in_frame->pts;

            // 2. Encode the frame
            int send_ret = avcodec_send_frame(codecContext, scopeFrame);
            if (send_ret >= 0) {
                while (true) {
                    int recv_ret = avcodec_receive_packet(codecContext, packet);
                    if (recv_ret == AVERROR(EAGAIN) || recv_ret == AVERROR_EOF) {
                        break;
                    } else if (recv_ret < 0) {
                        char errStr[AV_ERROR_MAX_STRING_SIZE] = {0};
                        av_make_error_string(errStr, AV_ERROR_MAX_STRING_SIZE, recv_ret);
                        fprintf(stderr, "[FFmpeg] Error during waveform encoding: %s\n", errStr);
                        break;
                    }
                    if (webrtc_handler) {
                        webrtc_handler->SendEncoded("video-wf", packet);
                    }
                    av_packet_unref(packet);
                }
            } else {
                char errStr[AV_ERROR_MAX_STRING_SIZE] = {0};
                av_make_error_string(errStr, AV_ERROR_MAX_STRING_SIZE, send_ret);
                fprintf(stderr, "[FFmpeg] Error sending waveform frame for encoding: %s\n", errStr);
            }
        }
    }

    void cleanup() {
        if (filter_graph) {
            avfilter_graph_free(&filter_graph);
            filter_graph = nullptr;
        }
        buffersrc_ctx = nullptr;
        buffersink_ctx = nullptr;

        if (codecContext) avcodec_free_context(&codecContext);
        if (packet) av_packet_free(&packet);
        if (scopeFrame) av_frame_free(&scopeFrame);
        
        codecContext = nullptr;
        packet = nullptr;
        scopeFrame = nullptr;
        webrtc_handler = nullptr;
        initialized = false;
    }

private:
    bool filter_frame(const AVFrame* in_frame, AVFrame* out_frame) {
        int ret = av_buffersrc_add_frame_flags(buffersrc_ctx, (AVFrame*)in_frame, AV_BUFFERSRC_FLAG_KEEP_REF);
        if (ret < 0) {
            std::cerr << "Error while feeding the filtergraph" << std::endl;
            return false;
        }

        av_frame_unref(out_frame);
        ret = av_buffersink_get_frame(buffersink_ctx, out_frame);
        if (ret < 0) {
            if (ret != AVERROR(EAGAIN) && ret != AVERROR_EOF) {
                 char errStr[AV_ERROR_MAX_STRING_SIZE] = {0};
                 av_make_error_string(errStr, AV_ERROR_MAX_STRING_SIZE, ret);
                fprintf(stderr, "Error receiving frame from filter graph: %s\n", errStr);
            }
            return false;
        }
        return true;
    }

    // filter
    AVFilterGraph* filter_graph = nullptr;
    AVFilterContext* buffersrc_ctx = nullptr;
    AVFilterContext* buffersink_ctx = nullptr;
    // encoder
    AVCodecContext* codecContext = nullptr;
    AVPacket* packet = nullptr;
    AVFrame* scopeFrame = nullptr;
    // webrtc
    std::shared_ptr<WebRTC> webrtc_handler = nullptr;
    bool initialized = false;
};
