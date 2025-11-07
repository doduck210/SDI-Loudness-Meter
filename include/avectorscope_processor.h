#pragma once

#include <vector>
#include <functional>
#include <string>
#include <stdio.h>
#include <sstream>
#include <cstring>

// All FFmpeg includes are now in this header
extern "C" {
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/opt.h>
#include <libavutil/pixfmt.h>
#include <libavutil/pixdesc.h>
#include <libavutil/frame.h>
#include <libavutil/channel_layout.h>
}

#include "base64.h" // This dependency is now in the header

// Audio constants
const int AVECTORSCOPE_AUDIO_SAMPLE_RATE = 48000;

class AVectorscopeProcessor {
public:
    AVectorscopeProcessor() {
        m_filterGraph = nullptr;
        m_bufferSrcCtx = nullptr;
        m_bufferSinkCtx = nullptr;
    }

    ~AVectorscopeProcessor() {
        if (m_filterGraph) {
            avfilter_graph_free(&m_filterGraph);
        }
    }

    // Non-copyable
    AVectorscopeProcessor(const AVectorscopeProcessor&) = delete;
    AVectorscopeProcessor& operator=(const AVectorscopeProcessor&) = delete;

    inline bool initialize() {
        char args[512];
        int ret;

        const AVFilter *abuffersrc  = avfilter_get_by_name("abuffer");
        const AVFilter *volume      = avfilter_get_by_name("volume");
        const AVFilter *avectorscope = avfilter_get_by_name("avectorscope");
        const AVFilter *format      = avfilter_get_by_name("format");
        const AVFilter *buffersink = avfilter_get_by_name("buffersink");

        AVFilterContext* volume_ctx;
        AVFilterContext* avectorscope_ctx;
        AVFilterContext* format_ctx;

        m_filterGraph = avfilter_graph_alloc();
        if (!m_filterGraph) {
            fprintf(stderr, "Cannot allocate filter graph\n");
            return false;
        }

        snprintf(args, sizeof(args), "time_base=1/%d:sample_rate=%d:sample_fmt=%s:channel_layout=stereo",
                 AVECTORSCOPE_AUDIO_SAMPLE_RATE, AVECTORSCOPE_AUDIO_SAMPLE_RATE, av_get_sample_fmt_name(AV_SAMPLE_FMT_FLTP));
        ret = avfilter_graph_create_filter(&m_bufferSrcCtx, abuffersrc, "in", args, NULL, m_filterGraph);
        if (ret < 0) {
            fprintf(stderr, "Cannot create audio buffer source\n");
            avfilter_graph_free(&m_filterGraph);
            return false;
        }

        ret = avfilter_graph_create_filter(&volume_ctx, volume, "volume", "volume=3.0", NULL, m_filterGraph);
        if (ret < 0) {
            fprintf(stderr, "Cannot create volume filter\n");
            avfilter_graph_free(&m_filterGraph);
            return false;
        }

        ret = avfilter_graph_create_filter(&avectorscope_ctx, avectorscope, "avectorscope", NULL, NULL, m_filterGraph);
        if (ret < 0) {
            fprintf(stderr, "Cannot create avectorscope filter\n");
            avfilter_graph_free(&m_filterGraph);
            return false;
        }
        av_opt_set(avectorscope_ctx, "size", "250x250", 0);
        av_opt_set_int(avectorscope_ctx, "mode", 1, 0); // Use 1 for lissajous_xy

        snprintf(args, sizeof(args), "pix_fmts=%s", av_get_pix_fmt_name(AV_PIX_FMT_RGB24));
        ret = avfilter_graph_create_filter(&format_ctx, format, "format", args, NULL, m_filterGraph);
        if (ret < 0) {
            fprintf(stderr, "Cannot create format filter\n");
            avfilter_graph_free(&m_filterGraph);
            return false;
        }

        ret = avfilter_graph_create_filter(&m_bufferSinkCtx, buffersink, "out", NULL, NULL, m_filterGraph);
        if (ret < 0) {
            fprintf(stderr, "Cannot create video buffer sink\n");
            avfilter_graph_free(&m_filterGraph);
            return false;
        }

        if ((ret = avfilter_link(m_bufferSrcCtx, 0, volume_ctx, 0)) < 0 ||
            (ret = avfilter_link(volume_ctx, 0, avectorscope_ctx, 0)) < 0 ||
            (ret = avfilter_link(avectorscope_ctx, 0, format_ctx, 0)) < 0 ||
            (ret = avfilter_link(format_ctx, 0, m_bufferSinkCtx, 0)) < 0) {
            fprintf(stderr, "Error linking filters: %d\n", ret);
            avfilter_graph_free(&m_filterGraph);
            return false;
        }

        if ((ret = avfilter_graph_config(m_filterGraph, NULL)) < 0) {
            fprintf(stderr, "Error configuring the filter graph: %d\n", ret);
            avfilter_graph_free(&m_filterGraph);
            return false;
        }

        return true;
    }

    inline void processAudio(
        const std::vector<float>& left,
        const std::vector<float>& right,
        unsigned int sampleCount,
        const std::function<void(const std::string&)>& sendMessageCallback)
    {
        if (sampleCount == 0) return;

        AVFrame *scope_frame = av_frame_alloc();
        if (!scope_frame) return;

        scope_frame->sample_rate    = AVECTORSCOPE_AUDIO_SAMPLE_RATE;
        scope_frame->format         = AV_SAMPLE_FMT_FLTP;
        scope_frame->channel_layout = AV_CH_LAYOUT_STEREO;
        scope_frame->nb_samples     = sampleCount;

        if (av_frame_get_buffer(scope_frame, 0) == 0) {
            memcpy(scope_frame->data[0], left.data(), sampleCount * sizeof(float));
            memcpy(scope_frame->data[1], right.data(), sampleCount * sizeof(float));

            if (av_buffersrc_add_frame_flags(m_bufferSrcCtx, scope_frame, AV_BUFFERSRC_FLAG_KEEP_REF) >= 0) {
                AVFrame *filt_frame = av_frame_alloc();
                if (filt_frame) {
                    while (av_buffersink_get_frame(m_bufferSinkCtx, filt_frame) >= 0) {
                        if (filt_frame->width > 0) {
                            send_vectorscope_ws_impl(filt_frame, sendMessageCallback);
                        }
                        av_frame_unref(filt_frame);
                    }
                    av_frame_free(&filt_frame);
                }
            }
        }

        av_frame_free(&scope_frame);
    }

private:
    AVFilterGraph*   m_filterGraph;
    AVFilterContext* m_bufferSrcCtx;
    AVFilterContext* m_bufferSinkCtx;

    static inline void send_vectorscope_ws_impl(AVFrame *pFrame, const std::function<void(const std::string&)>& sendMessageCallback) {
        const int width = pFrame->width;
        const int height = pFrame->height;
        const int rowStride = width * 3;

        std::string rgbBuffer;
        rgbBuffer.resize(static_cast<size_t>(rowStride) * height);
        for (int y = 0; y < height; ++y) {
            memcpy(rgbBuffer.data() + static_cast<size_t>(y) * rowStride,
                   (char*)pFrame->data[0] + y * pFrame->linesize[0],
                   rowStride);
        }

        std::string encoded_data = base64_encode(
            reinterpret_cast<const unsigned char*>(rgbBuffer.data()),
            rgbBuffer.size());

        std::ostringstream oss;
        oss << "{\"type\": \"vectorscope\", \"width\": " << width
            << ", \"height\": " << height
            << ", \"encoding\": \"rgb\", \"data\": \"" << encoded_data << "\"}";
        sendMessageCallback(oss.str());
    }
};
