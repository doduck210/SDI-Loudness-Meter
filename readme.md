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

    *   **FFmpeg Libraries**:
        *On Ubuntu/Debian:*
        ```bash
        sudo apt-get update
        sudo apt-get install libavformat-dev libavfilter-dev libavdevice-dev libavutil-dev
        ```

    *   **FFTW3 Library**:
        *On Ubuntu/Debian:*
        ```bash
        sudo apt-get update
        sudo apt-get install libfftw3-dev
        ```

    *   **Third-party Libraries (Asio, WebSocket++, & libdatachannel)**:
        This project uses several third-party libraries that need to be placed in the `libs` directory.

        First, ensure you have the necessary build tools for `libdatachannel`:
        *On Ubuntu/Debian:*
        ```bash
        sudo apt-get install cmake libssl-dev
        ```

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
        mkdir build
        cd build
        cmake .. \
          -DNO_MEDIA=OFF \
          -DNO_WEBSOCKET=OFF \
          -DPREFER_SYSTEM_LIB=ON \
          -DCMAKE_BUILD_TYPE=Release
        cmake --build . --config Release
        
        cd ../../.. # Return to the project root directory
        ```
        *Note: The Makefile assumes the libraries are located in the `libs` directory. After these steps, your directory structure should include `libs/asio-1.28.1`, `libs/websocketpp`, and `libs/libdatachannel` (with build artifacts inside it).*

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

1.  **Start the Web Server**:
    This will start the WebSocket server and serve the web interface.
    ```bash
    node server.js
    ```
    The server will be running at `http://localhost:8080`.

2.  **Run the Capture Application**:
    Open a new terminal and run the `Capture` executable.
    ```bash
    ./Capture -d 0 -m -1
    ```
    You can use the `-h` flag to see all available options.
    *   `-d <device_index>`: Selects the DeckLink device to use (starts from 0).
    *   `-m <display_mode>`: Selects the video display mode. Using `-1` enables auto-detection.

3.  **View the Output**:
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