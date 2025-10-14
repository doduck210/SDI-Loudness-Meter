#ifndef VIDEOPROCESSOR_H
#define VIDEOPROCESSOR_H

#include "DeckLinkAPI.h"
#include <string>
#include <functional>
#include <memory>

#include "WebRTC.h"

// FFmpeg headers
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

class VideoProcessor {
public:
    VideoProcessor();
    ~VideoProcessor();

    bool initialize(int width, int height, BMDTimeValue timeScale, BMDTimeValue frameDuration, BMDPixelFormat pixelFormat);
    void processFrame(IDeckLinkVideoInputFrame* frame, const std::function<void(const std::string&)>& send_ws_message);
    void stop();

private:
    bool initialized;
    AVCodecContext* codecContext;
    AVFormatContext* formatContext;
    AVFrame* srcFrame;
    AVFrame* dstFrame;
    AVPacket* packet;
    SwsContext* swsContext;
    AVPixelFormat sourcePixelFormat;

    std::shared_ptr<WebRTC> webrtc_handler;

    void cleanup();
};

#endif // VIDEOPROCESSOR_H