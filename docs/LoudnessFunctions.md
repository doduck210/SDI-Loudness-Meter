# Custom Loudness Measurement Function Descriptions

This document describes the purpose and core implementation of the Momentary, Short-term, LRA (Loudness Range), and Integrated Loudness functions implemented in the `include/LKFS.h` header file. These functions are based on an [open-source C++ implementation](https://github.com/jasonho610/ITU-R_BS.1770-4_cpp) of the [ITU-R BS.1770-4](https://www.itu.int/rec/R-REC-BS.1770-4-201510-I/en) standard, which has been modified and extended for real-time processing.

## 1. Momentary Loudness (`Momentary_loudness`)

Measures the instantaneous loudness over a 400ms audio data window.

### Core Implementation

1.  **Input**: 400ms of stereo PCM audio data (`std::vector<double>`, 19,200 samples at 48kHz).
2.  **K-Weighting Filter**: Applies the K-weighting filter defined in the BS.1770 standard to the audio data. This filter adjusts the frequency response to reflect human hearing characteristics.
3.  **Mean Square**: Calculates the mean square value over the entire 400ms window to determine the signal's energy.
4.  **LKFS Conversion**: Converts the calculated mean square value to a logarithmic scale to obtain the final Momentary Loudness (M-LKFS) value.
    - `l = -0.691 + 10.0 * log10(z_left + z_right)`

> Gating is not applied as this is a calculation for a single measurement block.

## 2. Short-term Loudness (`ShortTerm_loudness`)

Measures the short-term loudness over a 3-second audio data window.

### Core Implementation

1.  **Input**: 3 seconds of stereo PCM audio data (`std::vector<double>`, 144,000 samples at 48kHz).
2.  **K-Weighting Filter**: Same as `Momentary_loudness`, the K-weighting filter is applied to the entire 3-second audio data.
3.  **Mean Square**: Calculates the mean square value over the entire 3-second filtered signal.
4.  **LKFS Conversion**: Converts the mean square value to a logarithmic scale to obtain the Short-term Loudness (S-LKFS) value.

> Gating is not applied here either, as it is a measurement over a single 3-second block.

## 3. Integrated Loudness from Momentary Values (`integrated_loudness_with_momentaries`)

Calculates the overall program Integrated Loudness using a series of Momentary Loudness values accumulated over time.

### Core Implementation

1.  **Input**: A vector of M-LKFS values (`std::vector<double>`) measured at 100ms intervals via the `Momentary_loudness` function.
2.  **Energy Conversion**: Each M-LKFS value is converted back to its mean square energy (`z`) value.
3.  **Absolute Gating**: Blocks with a loudness below -70 LKFS are excluded from the measurement. This prevents very quiet sections from affecting the overall loudness calculation.
4.  **Relative Gating**:
    a. The average energy of the blocks that passed the absolute gate is calculated.
    b. A relative threshold is set 10 LU below the loudness corresponding to this average energy.
    c. Any measured M-LKFS value below this relative threshold is also excluded.
5.  **Final Average**: The average of the energy values that passed all gating stages is computed.
6.  **I-LKFS Conversion**: This final average energy is converted back to a logarithmic scale to obtain the Integrated Loudness (I-LKFS) value.

## 4. Loudness Range (`LRA_with_shorts`)

Calculates the Loudness Range (LRA), which represents the dynamic range of the program, based on Short-term Loudness values.

### Core Implementation

1.  **Input**: A vector of S-LKFS values (`std::vector<double>`) measured at 1-second intervals via the `ShortTerm_loudness` function.
2.  **Gating**:
    a. **Absolute Gating**: S-LKFS values below -70 LKFS are excluded.
    b. **Relative Gating**: A threshold is set **20 LU** below the average loudness of the absolute-gated values, and S-LKFS values below this are also excluded. (A -20LU threshold is used for LRA calculations).
3.  **Percentile Calculation**:
    a. The final gated S-LKFS values are sorted in ascending order.
    b. The value at the 10th percentile (L10) and the value at the 95th percentile (L95) are calculated from the sorted list using linear interpolation.
4.  **LRA Calculation**: The LRA is defined as `L95 - L10`. This value represents the difference between the loudest and quietest parts of the program.

---

# 사용자 정의 Loudness 측정 함수 설명

이 문서는 `include/LKFS.h` 헤더 파일에 구현된 Momentary, Short-term, LRA (Loudness Range), Integrated Loudness 계산 함수의 목적과 핵심 구현 방법을 설명한다. 이 함수들은 [ITU-R BS.1770-4](https://www.itu.int/rec/R-REC-BS.1770-4-201510-I/en) 표준을 기반으로 C++로 구현된 [오픈소스](https://github.com/jasonho610/ITU-R_BS.1770-4_cpp)를 바탕으로, 실시간 처리에 맞게 수정 및 기능 추가되었다.

## 1. Momentary Loudness (`Momentary_loudness`)

400ms 길이의 오디오 데이터에 대한 순간적인 라우드니스를 측정한다.

### 주요 구현 방법

1.  **입력**: 48kHz 샘플링 레이트 기준 400ms에 해당하는 스테레오 PCM 오디오 데이터 (`std::vector<double>` 타입, 19,200 샘플).
2.  **K-Weighting 필터 적용**: BS.1770 표준에 정의된 K-가중 필터를 오디오 데이터에 적용한다. 이 필터는 사람의 청각 특성을 반영하여 주파수 응답을 보정하는 역할을 한다.
3.  **평균 제곱 (Mean Square) 계산**: 필터링된 신호의 에너지를 계산하기 위해 400ms 구간 전체에 대해 평균 제곱 값을 구한다.
4.  **LKFS 변환**: 계산된 평균 제곱 값을 로그 스케일로 변환하여 최종적인 Momentary Loudness (M-LKFS) 값을 얻는다.
    - `l = -0.691 + 10.0 * log10(z_left + z_right)`

> 이 함수는 단일 측정 블록에 대한 계산이므로 게이팅(Gating) 과정은 포함되지 않는다.

## 2. Short-term Loudness (`ShortTerm_loudness`)

3초 길이의 오디오 데이터에 대한 단기 라우드니스를 측정한다.

### 주요 구현 방법

1.  **입력**: 48kHz 샘플링 레이트 기준 3초에 해당하는 스테레오 PCM 오디오 데이터 (`std::vector<double>` 타입, 144,000 샘플).
2.  **K-Weighting 필터 적용**: `Momentary_loudness`와 동일하게 K-가중 필터를 3초 전체 오디오 데이터에 적용한다.
3.  **평균 제곱 (Mean Square) 계산**: 필터링된 3초 신호 전체에 대해 평균 제곱 값을 계산한다.
4.  **LKFS 변환**: 계산된 평균 제곱 값을 로그 스케일로 변환하여 Short-term Loudness (S-LKFS) 값을 얻는다.

> 이 함수 역시 3초라는 단일 측정 구간에 대한 계산이므로 게이팅(Gating) 과정은 포함되지 않는다.

## 3. Integrated Loudness from Momentary Values (`integrated_loudness_with_momentaries`)

일정 시간 동안 누적된 다수의 Momentary Loudness 값들을 사용하여 프로그램 전체의 Integrated Loudness를 계산한다.

### 주요 구현 방법

1.  **입력**: `Momentary_loudness` 함수를 통해 100ms 간격으로 측정된 M-LKFS 값들의 벡터 (`std::vector<double>`).
2.  **에너지 변환**: 각 M-LKFS 값을 다시 평균 제곱 에너지(`z`) 값으로 역변환한다.
3.  **절대값 게이팅 (Absolute Gating)**: 라우드니스 값이 -70 LKFS 미만인 구간은 측정에서 제외한다. 이는 매우 조용한 구간이 전체 라우드니스에 미치는 영향을 배제하기 위함이다.
4.  **상대값 게이팅 (Relative Gating)**:
    a. 절대값 게이팅을 통과한 값들의 평균 에너지를 계산한다.
    b. 이 평균 에너지에 해당하는 라우드니스 값보다 10 LU 낮은 값을 상대적 임계값(Relative Threshold)으로 설정한다.
    c. 측정된 모든 M-LKFS 값 중 이 상대적 임계값보다 낮은 값을 추가로 제외한다.
5.  **최종 평균 계산**: 모든 게이팅 과정을 통과한 에너지 값들의 평균을 구한다.
6.  **I-LKFS 변환**: 최종 평균 에너지를 다시 로그 스케일로 변환하여 Integrated Loudness (I-LKFS) 값을 얻는다.

## 4. Loudness Range (`LRA_with_shorts`)

프로그램의 동적 범위를 나타내는 라우드니스 레인지(LRA)를 Short-term Loudness 값들을 기반으로 계산한다.

### 주요 구현 방법

1.  **입력**: `ShortTerm_loudness` 함수를 통해 1초 간격으로 측정된 S-LKFS 값들의 벡터 (`std::vector<double>`).
2.  **게이팅 (Gating)**:
    a. **절대값 게이팅**: -70 LKFS 미만의 S-LKFS 값을 제외한다.
    b. **상대값 게이팅**: 절대값 게이팅을 통과한 값들의 평균 라우드니스보다 **20 LU** 낮은 값을 임계값으로 설정하고, 이보다 낮은 S-LKFS 값을 추가로 제외한다. (LRA 계산 시에는 -20LU 기준을 적용)
3.  **백분위수 계산 (Percentile Calculation)**:
    a. 게이팅을 통과한 최종 S-LKFS 값들을 오름차순으로 정렬한다.
    b. 정렬된 값들에서 하위 10%에 해당하는 값(L10)과 상위 95%에 해당하는 값(L95)을 선형 보간법(linear interpolation)을 사용하여 계산한다.
4.  **LRA 계산**: LRA는 `L95 - L10`으로 정의된다. 이 값은 프로그램의 가장 큰 소리와 작은 소리 간의 차이를 나타낸다.