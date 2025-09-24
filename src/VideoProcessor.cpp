#include "VideoProcessor.h"
#include <iostream>

VideoProcessor::VideoProcessor() : initialized(false) {
    // Constructor
}

VideoProcessor::~VideoProcessor() {
    if (initialized) {
        // Clean up resources
        std::cerr << "VideoProcessor cleaned up." << std::endl;
    }
}

bool VideoProcessor::initialize(int width, int height, BMDTimeValue timeScale, BMDTimeValue frameDuration) {
    // Initialize FFmpeg or other video processing libraries here
    // For now, we'll just mark it as initialized
    initialized = true;
    std::cerr << "VideoProcessor initialized for " << width << "x" << height << std::endl;
    return true;
}

void VideoProcessor::processFrame(IDeckLinkVideoInputFrame* frame, const std::function<void(const std::string&)>& send_ws_message) {
    if (!initialized || !frame) {
        return;
    }

    // Example: Get frame data and send a message
    // This is where you would convert YUV to RGB, encode, etc.
    void* frameBytes;
    frame->GetBytes(&frameBytes);
    
    // For demonstration, we'll just send a simple message.
    // In a real scenario, you would process the video and send resulting data.
    // std::string video_data_msg = "{"type": "video_frame", "size": " + std::to_string(frame->GetRowBytes() * frame->GetHeight()) + "}";
    // send_ws_message(video_data_msg);
}

void VideoProcessor::stop() {
    // Stop processing, clean up
    initialized = false;
}
