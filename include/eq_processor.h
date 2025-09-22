#pragma once

#include <vector>
#include <string>
#include <sstream>
#include <functional>
#include <cmath>
#include <fftw3.h>

class EQProcessor {
public:
    EQProcessor() : g_fft_plan_l(nullptr), g_fft_plan_r(nullptr),
                    g_fft_in_l(nullptr), g_fft_in_r(nullptr),
                    g_fft_out_l(nullptr), g_fft_out_r(nullptr) {}

    ~EQProcessor() {
        if (g_fft_plan_l) fftw_destroy_plan(g_fft_plan_l);
        if (g_fft_plan_r) fftw_destroy_plan(g_fft_plan_r);
        if (g_fft_in_l) fftw_free(g_fft_in_l);
        if (g_fft_out_l) fftw_free(g_fft_out_l);
        if (g_fft_in_r) fftw_free(g_fft_in_r);
        if (g_fft_out_r) fftw_free(g_fft_out_r);
    }

    // Non-copyable
    EQProcessor(const EQProcessor&) = delete;
    EQProcessor& operator=(const EQProcessor&) = delete;

    void initialize() {
        g_fft_in_l = (double*) fftw_malloc(sizeof(double) * kFftSize);
        g_fft_out_l = (fftw_complex*) fftw_malloc(sizeof(fftw_complex) * (kFftSize / 2 + 1));
        g_fft_plan_l = fftw_plan_dft_r2c_1d(kFftSize, g_fft_in_l, g_fft_out_l, FFTW_ESTIMATE);

        g_fft_in_r = (double*) fftw_malloc(sizeof(double) * kFftSize);
        g_fft_out_r = (fftw_complex*) fftw_malloc(sizeof(fftw_complex) * (kFftSize / 2 + 1));
        g_fft_plan_r = fftw_plan_dft_r2c_1d(kFftSize, g_fft_in_r, g_fft_out_r, FFTW_ESTIMATE);
    }

    void processAudio(const double* left_samples, const double* right_samples, unsigned int sample_count, const std::function<void(const std::string&)>& sendMessageCallback) {
        if (!g_fft_plan_l || !g_fft_plan_r) return; // Not initialized

        fft_buffer_l.insert(fft_buffer_l.end(), left_samples, left_samples + sample_count);
        fft_buffer_r.insert(fft_buffer_r.end(), right_samples, right_samples + sample_count);

        if (fft_buffer_l.size() >= kFftSize) {
            // Copy data to FFTW input buffers and apply Hann window
            for (size_t i = 0; i < kFftSize; i++) {
                double window = 0.5 * (1 - cos(2 * M_PI * i / (kFftSize - 1)));
                g_fft_in_l[i] = fft_buffer_l[i] * window;
                g_fft_in_r[i] = fft_buffer_r[i] * window;
            }

            // Execute FFT
            fftw_execute(g_fft_plan_l);
            fftw_execute(g_fft_plan_r);

            // Calculate averaged and normalized magnitude spectrum
            std::vector<double> magnitudes(kFftSize / 2 + 1);
            const double kEqGain = 15.0; // Visual gain factor

            for (size_t i = 0; i < magnitudes.size(); ++i) {
                double mag_l = sqrt(g_fft_out_l[i][0] * g_fft_out_l[i][0] + g_fft_out_l[i][1] * g_fft_out_l[i][1]);
                double mag_r = sqrt(g_fft_out_r[i][0] * g_fft_out_r[i][0] + g_fft_out_r[i][1] * g_fft_out_r[i][1]);
                double normalized_mag = ((mag_l + mag_r) / 2.0) / (kFftSize / 2.0);
                magnitudes[i] = normalized_mag * kEqGain;
            }

            // Group magnitudes into logarithmic bands
            std::vector<double> bands(kNumBands);
            const double min_freq = 20.0;
            const double max_freq = 20000.0;
            double log_min = log(min_freq);
            double log_max = log(max_freq);
            double log_range = log_max - log_min;

            for (int i = 0; i < kNumBands; ++i) {
                double band_log_start = log_min + (log_range / kNumBands) * i;
                double band_log_end = log_min + (log_range / kNumBands) * (i + 1);
                double band_freq_start = exp(band_log_start);
                double band_freq_end = exp(band_log_end);

                int bin_start = static_cast<int>(band_freq_start * kFftSize / kAudioSampleRate);
                int bin_end = static_cast<int>(band_freq_end * kFftSize / kAudioSampleRate);
                if (bin_end >= magnitudes.size()) bin_end = magnitudes.size() - 1;
                if (bin_start > bin_end) bin_start = bin_end;

                double max_mag = 0.0;
                for (int j = bin_start; j <= bin_end; ++j) {
                    if (magnitudes[j] > max_mag) {
                        max_mag = magnitudes[j];
                    }
                }
                bands[i] = (max_mag > 0.000001) ? (20.0 * log10(max_mag)) : -60.0;
            }

            // Create JSON message
            std::ostringstream oss_eq;
            oss_eq << "{\"type\": \"eq\", \"data\": [";
            for (int i = 0; i < kNumBands; ++i) {
                oss_eq << bands[i] << (i == kNumBands - 1 ? "" : ",");
            }
            oss_eq << "]}";
            sendMessageCallback(oss_eq.str());

            // Remove processed samples
            fft_buffer_l.erase(fft_buffer_l.begin(), fft_buffer_l.begin() + kFftSize);
            fft_buffer_r.erase(fft_buffer_r.begin(), fft_buffer_r.begin() + kFftSize);
        }
    }

private:
    // Constants
    static const int kFftSize = 2048;
    static const int kNumBands = 64;
    static const int kAudioSampleRate = 48000;

    // FFTW resources
    fftw_plan g_fft_plan_l, g_fft_plan_r;
    double *g_fft_in_l, *g_fft_in_r;
    fftw_complex *g_fft_out_l, *g_fft_out_r;

    // Buffers
    std::vector<double> fft_buffer_l;
    std::vector<double> fft_buffer_r;
};
