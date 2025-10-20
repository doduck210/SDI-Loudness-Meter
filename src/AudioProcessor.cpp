#include "AudioProcessor.h"
#include "LKFS.h"
#include <sstream>
#include <cmath>
#include <numeric>
#include <iostream>

AudioProcessor::AudioProcessor() : m_isIntegrating(false) {
}

bool AudioProcessor::initialize(const BMDConfig& config, std::function<void(const std::string&)> send_ws_message) {
    m_config = config;
    m_send_ws_message = send_ws_message;

    if (!m_avectorscopeProcessor.initialize()) {
        fprintf(stderr, "Failed to initialize vectorscope processor\n");
        return false;
    }
    m_eqProcessor.initialize();
    return true;
}

void AudioProcessor::startIntegration() {
    fprintf(stderr, "Received start integration command.\n");
    m_momentaryLoudnessHistory.clear();
    m_shortTermLoudnessHistory.clear();
    m_isIntegrating = true;
}

void AudioProcessor::stopIntegration() {
    fprintf(stderr, "Received stop integration command.\n");
    m_isIntegrating = false;
}

void AudioProcessor::processAudioPacket(IDeckLinkAudioInputPacket* audioFrame) {
    if (!audioFrame) {
        return;
    }

    void* audioFrameBytes;
    audioFrame->GetBytes(&audioFrameBytes);
    const unsigned int sampleFrameCount = audioFrame->GetSampleFrameCount();
    const unsigned int channelCount = m_config.m_audioChannels;
    const unsigned int sampleDepth = m_config.m_audioSampleDepth;

    const unsigned int leftChannel = m_config.m_leftAudioChannel;
    const unsigned int rightChannel = m_config.m_rightAudioChannel;

    if (leftChannel >= channelCount || rightChannel >= channelCount) {
        fprintf(stderr, "Error: Invalid audio channel selection. Left: %u, Right: %u, Total Channels: %u\n", leftChannel, rightChannel, channelCount);
        return;
    }

    double maxLeft = 0.0;
    double maxRight = 0.0;
    std::vector<double> current_left_samples;
    std::vector<double> current_right_samples;
    current_left_samples.reserve(sampleFrameCount);
    current_right_samples.reserve(sampleFrameCount);

    if (sampleDepth == 32) {
        int32_t* pcmData = (int32_t*)audioFrameBytes;
        for (unsigned int i = 0; i < sampleFrameCount; ++i) {
            double leftSample = (double)pcmData[i * channelCount + leftChannel] / 2147483648.0;
            double rightSample = (double)pcmData[i * channelCount + rightChannel] / 2147483648.0;
            if (std::abs(leftSample) > maxLeft) maxLeft = std::abs(leftSample);
            if (std::abs(rightSample) > maxRight) maxRight = std::abs(rightSample);
            m_leftChannelPcm.push_back(leftSample);
            m_rightChannelPcm.push_back(rightSample);
            m_shortTermLeftChannelPcm.push_back(leftSample);
            m_shortTermRightChannelPcm.push_back(rightSample);
            current_left_samples.push_back(leftSample);
            current_right_samples.push_back(rightSample);
        }
    } else if (sampleDepth == 16) {
        int16_t* pcmData = (int16_t*)audioFrameBytes;
        for (unsigned int i = 0; i < sampleFrameCount; ++i) {
            double leftSample = (double)pcmData[i * channelCount + leftChannel] / 32768.0;
            double rightSample = (double)pcmData[i * channelCount + rightChannel] / 32768.0;
            if (std::abs(leftSample) > maxLeft) maxLeft = std::abs(leftSample);
            if (std::abs(rightSample) > maxRight) maxRight = std::abs(rightSample);
            m_leftChannelPcm.push_back(leftSample);
            m_rightChannelPcm.push_back(rightSample);
            m_shortTermLeftChannelPcm.push_back(leftSample);
            m_shortTermRightChannelPcm.push_back(rightSample);
            current_left_samples.push_back(leftSample);
            current_right_samples.push_back(rightSample);
        }
    }

    double leftDb = (maxLeft > 0.0) ? (20.0 * log10(maxLeft)) : -100.0;
    double rightDb = (maxRight > 0.0) ? (20.0 * log10(maxRight)) : -100.0;
    std::ostringstream oss_levels;
    oss_levels << "{\"type\": \"levels\", \"left\": " << leftDb << ", \"right\": " << rightDb << "}";
    m_send_ws_message(oss_levels.str());

    if (sampleFrameCount > 0) {
        std::vector<float> leftChunk(m_leftChannelPcm.end() - sampleFrameCount, m_leftChannelPcm.end());
        std::vector<float> rightChunk(m_rightChannelPcm.end() - sampleFrameCount, m_rightChannelPcm.end());
        m_avectorscopeProcessor.processAudio(leftChunk, rightChunk, sampleFrameCount, m_send_ws_message);
    }

    while (m_leftChannelPcm.size() >= kWindowSizeInSamples) {
        std::vector<double> leftWindow(m_leftChannelPcm.begin(), m_leftChannelPcm.begin() + kWindowSizeInSamples);
        std::vector<double> rightWindow(m_rightChannelPcm.begin(), m_rightChannelPcm.begin() + kWindowSizeInSamples);
        double lkfs = Momentary_loudness(leftWindow, rightWindow, kAudioSampleRate);
        std::ostringstream oss;
        oss << "{\"type\": \"lkfs\", \"value\": " << lkfs << "}";
        m_send_ws_message(oss.str());
        if(m_isIntegrating){
            m_momentaryLoudnessHistory.push_back(lkfs);
            double i_lkfs = integrated_loudness_with_momentaries(m_momentaryLoudnessHistory, kAudioSampleRate);
            std::ostringstream oss_i;
            oss_i << "{\"type\": \"i_lkfs\", \"value\": " << i_lkfs << "}";
            m_send_ws_message(oss_i.str());
        }
        for (unsigned int i = 0; i < kSlideSizeInSamples; ++i) {
            m_leftChannelPcm.pop_front();
            m_rightChannelPcm.pop_front();
        }
    }

    while (m_shortTermLeftChannelPcm.size() >= kShortTermWindowSizeInSamples) {
        std::vector<double> leftWindow(m_shortTermLeftChannelPcm.begin(), m_shortTermLeftChannelPcm.begin() + kShortTermWindowSizeInSamples);
        std::vector<double> rightWindow(m_shortTermRightChannelPcm.begin(), m_shortTermRightChannelPcm.begin() + kShortTermWindowSizeInSamples);
        double s_lkfs = ShortTerm_loudness(leftWindow, rightWindow, kAudioSampleRate);
        std::ostringstream oss_s;
        oss_s << "{\"type\": \"s_lkfs\", \"value\": " << s_lkfs << "}";
        m_send_ws_message(oss_s.str());

        if (m_isIntegrating) {
            m_shortTermLoudnessHistory.push_back(s_lkfs);
            
            if (m_shortTermLoudnessHistory.size() > 1) { // Need at least 2 values for a range
                double lra = LRA_with_shorts(m_shortTermLoudnessHistory);
                std::ostringstream oss_lra;
                oss_lra << "{\"type\": \"lra\", \"value\": " << lra << "}";
                m_send_ws_message(oss_lra.str());
            }
        }

        for (unsigned int i = 0; i < kSlideSizeInSamples; ++i) {
            m_shortTermLeftChannelPcm.pop_front();
            m_shortTermRightChannelPcm.pop_front();
        }
    }

    if (sampleFrameCount > 0) {
        // Calculate and send correlation
        std::vector<float> left_float(current_left_samples.begin(), current_left_samples.end());
        std::vector<float> right_float(current_right_samples.begin(), current_right_samples.end());
        float correlation = m_correlatorProcessor.process(left_float.data(), right_float.data(), sampleFrameCount);
        std::ostringstream oss_corr;
        oss_corr << "{\"type\": \"correlation\", \"value\": " << correlation << "}";
        m_send_ws_message(oss_corr.str());

        m_eqProcessor.processAudio(current_left_samples.data(), current_right_samples.data(), sampleFrameCount,
            m_send_ws_message);
    }
}