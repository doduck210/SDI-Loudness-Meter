#ifndef VIDEOPROCESSOR_H
#define VIDEOPROCESSOR_H

#include "DeckLinkAPI.h"
#include <memory>
#include <mutex>
#include <string>

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
    void requestVectorScopeModeChange(const std::string& mode);

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

    std::mutex vectorscopeModeMutex;
    std::string pendingVectorScopeMode = "color4";
};

#endif // VIDEOPROCESSOR_H
