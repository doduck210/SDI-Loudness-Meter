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
*   Node.js and npm for the web interface.
*   Asio and WebSocket++ libraries.

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

    *   **Third-party Libraries (Asio & WebSocket++)**:
        This project uses Asio and WebSocket++. You need to download them and place them in the `libs` directory.
        ```bash
        mkdir -p libs
        cd libs

        # Download and extract Asio (check for the latest version)
        wget -O asio.tar.gz https://sourceforge.net/projects/asio/files/latest/download
        tar -zxvf asio.tar.gz

        # Download WebSocket++
        git clone https://github.com/zaphoyd/websocketpp.git
        
        cd ..
        ```
        *Note: The Makefile assumes the libraries are located in the `libs` directory. The directory structure should look like `libs/asio-1.28.1/include` and `libs/websocketpp`.*

    *   **Node.js Dependencies**:
        Install the necessary packages for the web UI.
        ```bash
        npm install
        ```

## Build

Compile the C++ capture application using the provided Makefile.

```bash
make
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