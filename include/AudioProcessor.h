#ifndef AUDIOPROCESSOR_H
#define AUDIOPROCESSOR_H

#include <functional>
#include <string>
#include <vector>
#include <deque>
#include "DeckLinkAPI.h"
#include "Config.h"
#include "avectorscope_processor.h"
#include "eq_processor.h"
#include "correlator_processor.h"

class AudioProcessor {
public:
    AudioProcessor();
    bool initialize(const BMDConfig& config, std::function<void(const std::string&)> send_ws_message);
    void processAudioPacket(IDeckLinkAudioInputPacket* audioFrame);
    void startIntegration();
    void stopIntegration();

private:
    BMDConfig m_config;
    std::function<void(const std::string&)> m_send_ws_message;

    AVectorscopeProcessor m_avectorscopeProcessor;
    EQProcessor m_eqProcessor;
    CorrelatorProcessor m_correlatorProcessor;

    std::deque<double> m_leftChannelPcm;
    std::deque<double> m_rightChannelPcm;
    std::deque<double> m_shortTermLeftChannelPcm;
    std::deque<double> m_shortTermRightChannelPcm;
    std::vector<double> m_momentaryLoudnessHistory;
    std::vector<double> m_shortTermLoudnessHistory;

    bool m_isIntegrating;

    static const int kAudioSampleRate = 48000;
    static const int kWindowSizeInSamples = kAudioSampleRate * 400 / 1000;
    static const int kShortTermWindowSizeInSamples = kAudioSampleRate * 3;
    static const int kSlideSizeInSamples = kAudioSampleRate * 100 / 1000;
};

#endif // AUDIOPROCESSOR_H
