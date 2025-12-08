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
#include <mutex>
#include "WebRTC.h"

class VideoVectorScope {
public:
    VideoVectorScope() = default;
    ~VideoVectorScope() {
        cleanup();
    }

    bool initialize(int width, int height, AVPixelFormat pix_fmt, AVRational time_base, AVRational frame_rate, std::shared_ptr<WebRTC> handler, const std::string& mode = "color4") {
        cleanup();
        webrtc_handler = handler;
        input_width = width;
        input_height = height;
        input_pix_fmt = pix_fmt;
        input_time_base = time_base;
        input_frame_rate = frame_rate;
        current_mode = sanitize_mode(mode);
        requested_mode = current_mode;
        mode_dirty = false;

        if (!setup_filter_graph()) {
            return false;
        }

        // 2. Initialize encoder
        const AVCodec* codec = avcodec_find_encoder_by_name("libx264");
        if (!codec) { std::cerr << "libx264 not found for vectorscope." << std::endl; return false; }

        codecContext = avcodec_alloc_context3(codec);
        if (!codecContext) { std::cerr << "Could not allocate vectorscope codec context." << std::endl; return false; }

        codecContext->bit_rate = 2000000;
        codecContext->width = 256;
        codecContext->height = 256;
        codecContext->time_base = input_time_base;
        codecContext->framerate = input_frame_rate;
        codecContext->gop_size = 30;
        codecContext->max_b_frames = 0;
        codecContext->pix_fmt = AV_PIX_FMT_YUV420P;
        codecContext->profile = FF_PROFILE_H264_BASELINE;
        codecContext->level = 31;

        av_opt_set(codecContext->priv_data, "preset", "ultrafast", 0);
        av_opt_set(codecContext->priv_data, "tune", "zerolatency", 0);
        av_opt_set(codecContext->priv_data, "x264-params", "repeat-headers=1", 0);

        if (avcodec_open2(codecContext, codec, NULL) < 0) { std::cerr << "Could not open vectorscope codec." << std::endl; return false; }

        // 3. Allocate frames and packet
        scopeFrame = av_frame_alloc();
        if (!scopeFrame) { std::cerr << "Could not allocate vectorscope frame." << std::endl; return false; }
        scopeFrame->width = 256;
        scopeFrame->height = 256;
        scopeFrame->format = AV_PIX_FMT_YUV420P;
        av_frame_get_buffer(scopeFrame, 0);

        packet = av_packet_alloc();
        if (!packet) { std::cerr << "Could not allocate packet." << std::endl; return false; }

        // 4. Register WebRTC track
        webrtc_handler->RegisterH264Track("video-vs","stream-vectorscope","video-vs", 44);
        std::cerr << "[Info] VideoVectorScope initialized successfully." << std::endl;
        initialized = true;
        return true;
    }

    void process_and_encode(const AVFrame* in_frame) {
        if (!initialized) return;

        apply_pending_mode();

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
                        fprintf(stderr, "[FFmpeg] Error during vectorscope encoding: %s\n", errStr);
                        break;
                    }
                    if (webrtc_handler) {
                        webrtc_handler->SendEncoded("video-vs", packet);
                    }
                    av_packet_unref(packet);
                }
            } else {
                char errStr[AV_ERROR_MAX_STRING_SIZE] = {0};
                av_make_error_string(errStr, AV_ERROR_MAX_STRING_SIZE, send_ret);
                fprintf(stderr, "[FFmpeg] Error sending vectorscope frame for encoding: %s\n", errStr);
            }
        }
    }

    void cleanup() {
        cleanup_filter_graph();
        if (codecContext) avcodec_free_context(&codecContext);
        if (packet) av_packet_free(&packet);
        if (scopeFrame) av_frame_free(&scopeFrame);
        
        codecContext = nullptr;
        packet = nullptr;
        scopeFrame = nullptr;
        webrtc_handler = nullptr;
        initialized = false;
    }

    void request_mode_change(const std::string& mode) {
        std::lock_guard<std::mutex> lock(mode_mutex);
        requested_mode = sanitize_mode(mode);
        if (requested_mode != current_mode) {
            mode_dirty = true;
        }
    }

private:
    static std::string sanitize_mode(const std::string& mode) {
        if (mode.empty()) return "color4";
        return mode;
    }

    bool setup_filter_graph() {
        cleanup_filter_graph();

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
            input_width, input_height, input_pix_fmt, input_time_base.num, input_time_base.den, input_frame_rate.num, input_frame_rate.den);

        int ret = avfilter_graph_create_filter(&buffersrc_ctx, buffersrc, "in", args, nullptr, filter_graph);
        if (ret < 0) { std::cerr << "Failed to create buffer source" << std::endl; return false; }

        ret = avfilter_graph_create_filter(&buffersink_ctx, buffersink, "out", nullptr, nullptr, filter_graph);
        if (ret < 0) { std::cerr << "Failed to create buffer sink" << std::endl; return false; }

        AVFilterInOut* outputs = avfilter_inout_alloc();
        AVFilterInOut* inputs = avfilter_inout_alloc();
        if (!outputs || !inputs) {
            std::cerr << "Failed to allocate filter graph in/out" << std::endl;
            avfilter_inout_free(&inputs);
            avfilter_inout_free(&outputs);
            return false;
        }

        outputs->name = av_strdup("in");
        outputs->filter_ctx = buffersrc_ctx;
        outputs->pad_idx = 0;
        outputs->next = nullptr;
        inputs->name = av_strdup("out");
        inputs->filter_ctx = buffersink_ctx;
        inputs->pad_idx = 0;
        inputs->next = nullptr;

        std::string filter_desc = "vectorscope=mode=" + current_mode + ":graticule=color:opacity=1.0:intensity=1.0,format=pix_fmts=yuv420p";
        ret = avfilter_graph_parse_ptr(filter_graph, filter_desc.c_str(), &inputs, &outputs, nullptr);
        if (ret < 0) {
            std::cerr << "Failed to parse filter graph" << std::endl;
            avfilter_inout_free(&inputs);
            avfilter_inout_free(&outputs);
            return false;
        }

        ret = avfilter_graph_config(filter_graph, nullptr);
        if (ret < 0) {
            std::cerr << "Failed to configure filter graph" << std::endl;
            avfilter_inout_free(&inputs);
            avfilter_inout_free(&outputs);
            return false;
        }

        avfilter_inout_free(&inputs);
        avfilter_inout_free(&outputs);
        return true;
    }

    void cleanup_filter_graph() {
        if (filter_graph) {
            avfilter_graph_free(&filter_graph);
            filter_graph = nullptr;
        }
        buffersrc_ctx = nullptr;
        buffersink_ctx = nullptr;
    }

    void apply_pending_mode() {
        std::string newMode;
        {
            std::lock_guard<std::mutex> lock(mode_mutex);
            if (!mode_dirty || requested_mode == current_mode) {
                mode_dirty = false;
                return;
            }
            newMode = requested_mode;
            mode_dirty = false;
        }

        current_mode = newMode;
        if (!setup_filter_graph()) {
            std::cerr << "[Warning] Failed to apply vectorscope mode " << newMode << std::endl;
        }
    }

    bool filter_frame(const AVFrame* in_frame, AVFrame* out_frame) {
        if (!buffersrc_ctx || !buffersink_ctx) {
            return false;
        }
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

    int input_width = 0;
    int input_height = 0;
    AVPixelFormat input_pix_fmt = AV_PIX_FMT_NONE;
    AVRational input_time_base{0, 1};
    AVRational input_frame_rate{0, 1};
    std::string current_mode = "color4";
    std::string requested_mode = "color4";
    std::mutex mode_mutex;
    bool mode_dirty = false;

    bool initialized = false;
};
