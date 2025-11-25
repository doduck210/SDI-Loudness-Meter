# SDI Loudness Meter

This is a loudness meter for SDI signals that uses a Blackmagic DeckLink card. It measures momentary LKFS loudness and generates a vectorscope, then sends the data to a web interface via WebSockets.

## Features

*   Real-time LKFS momentary loudness monitoring.
*   Real-time audio vectorscope visualization.
*   Web-based user interface for remote monitoring.
*   Uses Blackmagic DeckLink cards for SDI input.

## Requirements

*   A system with a C++ compiler (like g++), `make`, and `git`.
*   A Blackmagic DeckLink capture card.
*   Blackmagic decklink driver (desktopvideo) installed.
*   FFmpeg libraries (development headers).
*   FFTW3 library (development headers).
*   Node.js and npm for the web interface.
*   `cmake` and `libssl-dev` for building WebRTC dependencies.
*   Asio, WebSocket++, and libdatachannel libraries.

## Installation Guide

1.  **Clone the Repository**
    ```bash
    git clone <repository-url>
    cd SDILoudnessMeter
    ```

2.  **Install Dependencies**

    *   **System Libraries (Ubuntu/Debian)**:
        Install all required development libraries and tools (like FFmpeg, FFTW3, CMake, and OpenSSL) with a single command:
        ```bash
        sudo apt-get update
        sudo apt-get install -y libavformat-dev libavfilter-dev libavdevice-dev libavutil-dev libfftw3-dev cmake libssl-dev
        ```

    *   **Third-party Libraries (Asio, WebSocket++, & libdatachannel)**:
        This project uses several third-party libraries that need to be placed in the `libs` directory.

        Now, set up the libraries:
        ```bash
        mkdir -p libs
        cd libs

        # 1. Asio (version 1.28.1 is required)
        wget https://downloads.sourceforge.net/project/asio/asio/1.28.1%20(Stable)/asio-1.28.1.tar.gz
        tar -zxvf asio-1.28.1.tar.gz

        # 2. WebSocket++
        git clone https://github.com/zaphoyd/websocketpp.git

        # 3. libdatachannel (for WebRTC)
        git clone https://github.com/paullouisageneau/libdatachannel.git
        cd libdatachannel
        git submodule update --init --recursive
        mkdir build
        cd build
        cmake .. \
          -DNO_MEDIA=OFF \
          -DNO_WEBSOCKET=OFF \
          -DPREFER_SYSTEM_LIB=OFF \
          -DCMAKE_INSTALL_PREFIX=../install \
          -DCMAKE_BUILD_TYPE=Release \
          -DBUILD_SHARED_LIBS=OFF
        cmake --build . --config Release
        cmake --install . --config Release
        
        cd ../../.. # Return to the project root directory
        ```
        *Note: The Makefile assumes the libraries are located in the `libs` directory. After these steps, your directory structure should include `libs/asio-1.28.1`, `libs/websocketpp`, and `libs/libdatachannel` (with static libraries for `libdatachannel` and its dependencies located in `libs/libdatachannel/install/lib`).*

    *   **Node.js Dependencies**:
        Install the necessary packages for the web UI.
        ```bash
        npm install
        ```

## Build

Compile the C++ capture application using the provided Makefile.

```bash
make
# or to use video
make video
```

## Usage

1.  **Start the Server**:
    This will start both the WebSocket server (serving the web interface at `http://localhost:8080`) and automatically launch the `Capture` application.
    ```bash
    npm start
    ```

2.  **View the Output**:
    Open your web browser and navigate to `http://localhost:8080` to see the real-time vectorscope and LKFS loudness values.

## Technical Notes

*   **Tested SDI Signal Info**:
    *   Audio: 48kHz PCM 24-bit Little Endian (pcm_s24le)
    *   Video: 59.94i 1920x1080 (video is used for timing only tho)

*   **Tested Environment**:
    *   OS: Ubuntu 22.04.5 LTS
    *   DeckLink Driver: Desktop Video 14.4.1a4
    *   CPU: 12th Gen Intel(R) Core(TM) i5-12600H
    *   RAM: 16 GB