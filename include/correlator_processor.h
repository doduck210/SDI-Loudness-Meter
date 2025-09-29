#pragma once

#include <vector>
#include <cmath>
#include <numeric>

class CorrelatorProcessor {
public:
    CorrelatorProcessor() = default;

    // Processes a block of stereo audio samples and returns the correlation.
    // Correlation is a value between -1.0 (perfectly out of phase) and +1.0 (perfectly in phase).
    // 0.0 indicates no correlation.
    //
    // The formula used is the Pearson correlation coefficient:
    //   sum(L[i] * R[i]) / (sqrt(sum(L[i]^2)) * sqrt(sum(R[i]^2)))
    // for N samples.
    float process(const float* left_channel, const float* right_channel, int samples) {
        if (samples == 0) {
            return 0.0f;
        }

        double sum_l_r = 0.0;
        double sum_l_sq = 0.0;
        double sum_r_sq = 0.0;

        for (int i = 0; i < samples; ++i) {
            sum_l_r += left_channel[i] * right_channel[i];
            sum_l_sq += left_channel[i] * left_channel[i];
            sum_r_sq += right_channel[i] * right_channel[i];
        }

        double denominator = std::sqrt(sum_l_sq) * std::sqrt(sum_r_sq);

        if (denominator == 0.0) {
            return 0.0f; // Or 1.0f if both channels are silent, depending on desired behavior
        }

        return static_cast<float>(sum_l_r / denominator);
    }
};
