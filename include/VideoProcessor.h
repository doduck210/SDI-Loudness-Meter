#ifndef VIDEOPROCESSOR_H
#define VIDEOPROCESSOR_H

#include "DeckLinkAPI.h"
#include <string>
#include <functional>

class VideoProcessor {
public:
    VideoProcessor();
    ~VideoProcessor();

    bool initialize(int width, int height, BMDTimeValue timeScale, BMDTimeValue frameDuration);
    void processFrame(IDeckLinkVideoInputFrame* frame, const std::function<void(const std::string&)>& send_ws_message);
    void stop();

private:
    // Private members for video processing, e.g., FFmpeg contexts
    bool initialized;
};

#endif // VIDEOPROCESSOR_H
