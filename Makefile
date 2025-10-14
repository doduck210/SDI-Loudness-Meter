CC=g++
SDK_PATH=./include
WEBSOCKETPP_PATH=./libs/websocketpp
ASIO_PATH=./libs/asio-1.28.1
TARGET = Capture

# --- Target Definitions ---
.PHONY: all audio video clean

# Default target
all: audio

audio:
	@echo "Building audio-only version..."
	@$(MAKE) -s $(TARGET)

video:
	@echo "Building with video processing and WebRTC enabled..."
	@$(MAKE) -s $(TARGET) ENABLE_VIDEO_PROCESSING=1

# --- Build Rules ---

# Base sources
SRCS = src/Capture.cpp src/Config.cpp src/DeckLinkAPIDispatch.cpp

# Base flags
CXXFLAGS += -Wno-multichar -I$(SDK_PATH) -I$(WEBSOCKETPP_PATH) -I$(ASIO_PATH)/include -DASIO_STANDALONE -std=c++17 -I./src
LDFLAGS += -lm -ldl -lpthread -lfftw3

# --- WebRTC Specific Flags ---
# NOTE: Using the locally built libdatachannel library.
WEBRTC_CXXFLAGS = -Ilibs/libdatachannel/install/include
WEBRTC_LDFLAGS = -Llibs/libdatachannel/install/lib -ldatachannel -ljuice -lusrsctp -lsrtp2 -lssl -lcrypto -lpthread

# Conditional sources and flags for Video Processing
ifneq ($(ENABLE_VIDEO_PROCESSING),)
	SRCS += src/VideoProcessor.cpp
	CXXFLAGS += -DENABLE_VIDEO_PROCESSING $(WEBRTC_CXXFLAGS)
	LDFLAGS += -lavcodec -lavfilter -lavformat -lavdevice -lavutil -lswscale -lswresample $(WEBRTC_LDFLAGS)
else
	LDFLAGS += -lavfilter -lavformat -lavdevice -lavutil
endif

# The actual build command for the target executable
$(TARGET): $(SRCS)
	$(CC) -o $(TARGET) $(SRCS) $(CXXFLAGS) $(LDFLAGS)

clean:
	@echo "Cleaning up..."
	@rm -f $(TARGET)
