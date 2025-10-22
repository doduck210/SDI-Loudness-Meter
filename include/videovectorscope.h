#pragma once

extern "C" {
#include <libavutil/avutil.h>
#include <libavutil/opt.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/frame.h>
#include <libavutil/error.h>
}

#include <stdexcept>
#include <string>
#include <iostream>

class VideoVectorScope {
public:
    VideoVectorScope() = default;
    ~VideoVectorScope() {
        cleanup();
    }

    bool initialize(int width, int height, AVPixelFormat pix_fmt, AVRational time_base, AVRational frame_rate) {
        cleanup();

        AVFilterGraph* graph = avfilter_graph_alloc();
        if (!graph) {
            std::cerr << "Failed to allocate filter graph" << std::endl;
            return false;
        }

        const AVFilter* buffersrc = avfilter_get_by_name("buffer");
        const AVFilter* buffersink = avfilter_get_by_name("buffersink");
        const AVFilter* vectorscope = avfilter_get_by_name("vectorscope");

        if (!buffersrc || !buffersink || !vectorscope) {
            std::cerr << "Failed to find required filters" << std::endl;
            avfilter_graph_free(&graph);
            return false;
        }

        char args[512];
        snprintf(args, sizeof(args),
            "video_size=%dx%d:pix_fmt=%d:time_base=%d/%d:frame_rate=%d/%d:pixel_aspect=1/1",
            width, height, pix_fmt, time_base.num, time_base.den, frame_rate.num, frame_rate.den);

        int ret = avfilter_graph_create_filter(&buffersrc_ctx, buffersrc, "in", args, nullptr, graph);
        if (ret < 0) {
            std::cerr << "Failed to create buffer source" << std::endl;
            avfilter_graph_free(&graph);
            return false;
        }

        ret = avfilter_graph_create_filter(&buffersink_ctx, buffersink, "out", nullptr, nullptr, graph);
        if (ret < 0) {
            std::cerr << "Failed to create buffer sink" << std::endl;
            avfilter_graph_free(&graph);
            return false;
        }

        AVFilterInOut* outputs = avfilter_inout_alloc();
        AVFilterInOut* inputs = avfilter_inout_alloc();
        
        if (!outputs || !inputs) {
            std::cerr << "Failed to allocate inout" << std::endl;
            avfilter_inout_free(&outputs);
            avfilter_inout_free(&inputs);
            avfilter_graph_free(&graph);
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

        // The input is already YUV420P, so we just need the vectorscope filter.
        const char* filter_desc = "vectorscope=graticule=color";

        ret = avfilter_graph_parse_ptr(graph, filter_desc, &inputs, &outputs, nullptr);
        if (ret < 0) {
            std::cerr << "Failed to parse filter graph" << std::endl;
            avfilter_inout_free(&inputs);
            avfilter_inout_free(&outputs);
            avfilter_graph_free(&graph);
            return false;
        }

        ret = avfilter_graph_config(graph, nullptr);
        if (ret < 0) {
            std::cerr << "Failed to configure filter graph" << std::endl;
            avfilter_inout_free(&inputs);
            avfilter_inout_free(&outputs);
            avfilter_graph_free(&graph);
            return false;
        }
        
        avfilter_inout_free(&inputs);
        avfilter_inout_free(&outputs);

        filter_graph = graph;
        return true;
    }

    // Processes an input frame and stores the result in an output frame.
    // The caller is responsible for allocating and freeing the output frame.
    bool process_frame(const AVFrame* in_frame, AVFrame* out_frame) {
        int ret = av_buffersrc_add_frame_flags(buffersrc_ctx, (AVFrame*)in_frame, AV_BUFFERSRC_FLAG_KEEP_REF);
        if (ret < 0) {
            std::cerr << "Error while feeding the filtergraph" << std::endl;
            return false;
        }

        av_frame_unref(out_frame);
        ret = av_buffersink_get_frame(buffersink_ctx, out_frame);
        if (ret < 0) {
            // EAGAIN means more data is needed, which is not an error in this context.
            // EOF means the stream is finished.
            if (ret != AVERROR(EAGAIN) && ret != AVERROR_EOF) {
                 char errStr[AV_ERROR_MAX_STRING_SIZE] = {0};
                 av_make_error_string(errStr, AV_ERROR_MAX_STRING_SIZE, ret);
                fprintf(stderr, "Error receiving frame from filter graph: %s\n", errStr);
            }
            return false;
        }

        return true;
    }

    void cleanup() {
        if (filter_graph) {
            avfilter_graph_free(&filter_graph);
            filter_graph = nullptr;
        }
        buffersrc_ctx = nullptr;
        buffersink_ctx = nullptr;
    }

private:
    AVFilterGraph* filter_graph = nullptr;
    AVFilterContext* buffersrc_ctx = nullptr;
    AVFilterContext* buffersink_ctx = nullptr;
};
