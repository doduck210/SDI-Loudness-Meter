# PC Resource Measurement
Measurement Method: `top -b -n 1 | grep Capture`  
For 2-channel operation:  
CPU Usage (`%CPU`): 6.7%  
Memory Usage (`%MEM`): 1.7%  

# Momentary Loudness Function Call Time Measurement
Measurement Method:   
Measure the time before and after the momentary_loudness call in Capture.cpp using chrono.
``` cpp
auto start = std::chrono::high_resolution_clock::now();
Momentary_loudness(leftWindow, rightWindow, kAudioSampleRate);
auto end = std::chrono::high_resolution_clock::now();
std::chrono::duration<double, std::milli> elapsed = end - start;
printf("Momentary_loudness execution time: %f ms\n", elapsed.count());
```
Result:
```
Momentary_loudness execution time: 5.746222 ms
Momentary_loudness execution time: 7.147923 ms
Momentary_loudness execution time: 4.046729 ms
Momentary_loudness execution time: 8.662711 ms
Momentary_loudness execution time: 9.068501 ms
Momentary_loudness execution time: 8.650554 ms
Momentary_loudness execution time: 6.440065 ms
Momentary_loudness execution time: 6.465683 ms
Momentary_loudness execution time: 6.713089 ms
Momentary_loudness execution time: 6.070892 ms
Momentary_loudness execution time: 6.421122 ms
Momentary_loudness execution time: 6.331712 ms
Momentary_loudness execution time: 6.523731 ms
Momentary_loudness execution time: 6.231814 ms
Momentary_loudness execution time: 6.106090 ms
Momentary_loudness execution time: 5.828094 ms
Momentary_loudness execution time: 6.242095 ms
Momentary_loudness execution time: 5.785054 ms
Momentary_loudness execution time: 6.436508 ms
Momentary_loudness execution time: 5.780781 ms
```

# AudioFrame Sample Count
Based on running with the default stereo setting.  
Around 1600 samples per channel are received in one audio frame.  
(Note: A 400ms window requires 19200 samples, and the slide step is 4800 samples)  
```
sampleframecount : 1602
sampleframecount : 1601
sampleframecount : 1602
sampleframecount : 1602
sampleframecount : 1601
sampleframecount : 1602
sampleframecount : 1601
sampleframecount : 1602
sampleframecount : 1602
sampleframecount : 1601
sampleframecount : 1602
sampleframecount : 1601
-inf
sampleframecount : 1602
sampleframecount : 1602
sampleframecount : 1601
-inf
sampleframecount : 1602
sampleframecount : 1601
sampleframecount : 1602
-33.674086
sampleframecount : 1601
sampleframecount : 1602
sampleframecount : 1601
-26.351646
sampleframecount : 1602
sampleframecount : 1602
sampleframecount : 1601
-25.513571
```