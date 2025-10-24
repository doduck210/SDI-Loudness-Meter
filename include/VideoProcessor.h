#ifndef VIDEOPROCESSOR_H
#define VIDEOPROCESSOR_H

#include "DeckLinkAPI.h"
#include <memory>

#include "WebRTC.h"
#include "rawvideoprocessor.h"
#include "videovectorscope.h"
#include "videowaveform.h"

// FFmpeg headers
extern "C" {
#include <libavutil/frame.h>
#include <libswscale/swscale.h>
}

class VideoProcessor {
public:
    VideoProcessor();
    ~VideoProcessor();

    bool initialize(int width, int height, BMDTimeValue timeScale, BMDTimeValue frameDuration, BMDPixelFormat pixelFormat);
    void processFrame(IDeckLinkVideoInputFrame* frame);
    void stop();

private:
    void cleanup();

    bool initialized;
    
    // Scaling
    SwsContext* swsContext;
    AVPixelFormat sourcePixelFormat;
    AVFrame* srcFrame;
    AVFrame* dstFrame;

    // WebRTC Handler
    std::shared_ptr<WebRTC> webrtc_handler;

    // Processors
    std::unique_ptr<RawVideoProcessor> raw_video_processor;
    std::unique_ptr<VideoVectorScope> vector_scope_processor;
    std::unique_ptr<VideoWaveform> waveform_processor;
};

#endif // VIDEOPROCESSOR_H