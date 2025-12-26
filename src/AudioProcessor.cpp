#include "AudioProcessor.h"
#include "LKFS.h"
#include <sstream>
#include <cmath>
#include <numeric>
#include <iostream>
#include <algorithm>

AudioProcessor::AudioProcessor() : m_isIntegrating(false) {
}

bool AudioProcessor::initialize(const BMDConfig& config, std::function<void(const std::string&)> send_ws_message) {
    m_config = config;
    m_send_ws_message = send_ws_message;

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

    std::vector<double> maxLevels(channelCount, 0.0);
    std::vector<double> current_left_samples;
    std::vector<double> current_right_samples;
    current_left_samples.reserve(sampleFrameCount);
    current_right_samples.reserve(sampleFrameCount);

    if (sampleDepth == 32) {
        int32_t* pcmData = (int32_t*)audioFrameBytes;
        for (unsigned int i = 0; i < sampleFrameCount; ++i) {
            for (unsigned int ch = 0; ch < channelCount; ++ch) {
                double sample = (double)pcmData[i * channelCount + ch] / 2147483648.0;
                if (std::abs(sample) > maxLevels[ch]) {
                    maxLevels[ch] = std::abs(sample);
                }
                if (ch == leftChannel) {
                    m_leftChannelPcm.push_back(sample);
                    m_shortTermLeftChannelPcm.push_back(sample);
                    current_left_samples.push_back(sample);
                }
                if (ch == rightChannel) {
                    m_rightChannelPcm.push_back(sample);
                    m_shortTermRightChannelPcm.push_back(sample);
                    current_right_samples.push_back(sample);
                }
            }
        }
    } else if (sampleDepth == 16) {
        int16_t* pcmData = (int16_t*)audioFrameBytes;
        for (unsigned int i = 0; i < sampleFrameCount; ++i) {
            for (unsigned int ch = 0; ch < channelCount; ++ch) {
                double sample = (double)pcmData[i * channelCount + ch] / 32768.0;
                if (std::abs(sample) > maxLevels[ch]) {
                    maxLevels[ch] = std::abs(sample);
                }
                if (ch == leftChannel) {
                    m_leftChannelPcm.push_back(sample);
                    m_shortTermLeftChannelPcm.push_back(sample);
                    current_left_samples.push_back(sample);
                }
                if (ch == rightChannel) {
                    m_rightChannelPcm.push_back(sample);
                    m_shortTermRightChannelPcm.push_back(sample);
                    current_right_samples.push_back(sample);
                }
            }
        }
    }

    double leftDb = (maxLevels[leftChannel] > 0.0) ? (20.0 * log10(maxLevels[leftChannel])) : -100.0;
    double rightDb = (maxLevels[rightChannel] > 0.0) ? (20.0 * log10(maxLevels[rightChannel])) : -100.0;
    std::ostringstream oss_levels;
    oss_levels << "{\"type\": \"levels\", \"left\": " << leftDb << ", \"right\": " << rightDb << ", \"all\": [";
    for (unsigned int ch = 0; ch < channelCount; ++ch) {
        double db = (maxLevels[ch] > 0.0) ? (20.0 * log10(maxLevels[ch])) : -100.0;
        oss_levels << db << (ch == channelCount - 1 ? "" : ",");
    }
    oss_levels << "]}";
    m_send_ws_message(oss_levels.str());

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
        sendVectorscopeSamples(current_left_samples, current_right_samples);

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

void AudioProcessor::sendVectorscopeSamples(const std::vector<double>& leftSamples,
                                            const std::vector<double>& rightSamples) {
    if (leftSamples.empty() || rightSamples.empty()) return;
    const size_t count = std::min(leftSamples.size(), rightSamples.size());
    if (count == 0) return;

    std::ostringstream oss;
    oss << "{\"type\": \"vectorscope_samples\", \"samples\": [";
    bool first = true;
    for (size_t i = 0; i < count; ++i) {
        const double x = std::clamp(leftSamples[i], -1.0, 1.0);
        const double y = std::clamp(rightSamples[i], -1.0, 1.0);
        if (!first) {
            oss << ",";
        }
        first = false;
        oss << "[" << x << "," << y << "]";
    }
    oss << "]}";
    m_send_ws_message(oss.str());
}
