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

## Docker

The repository ships with a `Dockerfile` that reproduces the Ubuntu 22.04 toolchain, builds `libdatachannel`, compiles `Capture`, and installs the Node.js server. The container does **not** include the DeckLink driver; you must install Blackmagic Desktop Video on the host and share its devices/libraries with Docker.

1. **Build the image**
    ```bash
    docker build -t sdiloudness-meter .
    ```
2. **Prepare the host**
    * Install the DeckLink/Desktop Video driver on the host and verify that `/dev/blackmagic/*` device nodes exist.
    * Locate the user-space libraries (usually `/usr/lib/blackmagic/libDeckLinkAPI.so`). This directory must be bind-mounted into the container so the `Capture` binary can `dlopen` the SDK just like a native install.
3. **Run the container**
    ```bash
    docker run --rm -it \
      --name sdiloudness \
      -p 8080:8080 \
      --device=/dev/blackmagic/io0 \
      --device=/dev/blackmagic/io1 \
      --device=/dev/blackmagic/audio0 \
      --device=/dev/blackmagic/serial0 \
      -v /usr/lib/blackmagic:/usr/lib/blackmagic:ro \
      sdiloudness-meter
    ```
    Adjust the `--device` flags to match the device nodes that exist on your workstation (`ls /dev/blackmagic`). The image’s default command runs `node server.js`, which in turn launches the `Capture` binary with the same defaults described earlier. Use the web UI or `curl -X POST http://localhost:8080/api/settings` to change device/mode/channel selections at runtime.

4. **Debugging inside the container (optional)**
    ```bash
    docker exec -it sdiloudness bash
    ```
    The compiled binary lives at `/app/Capture` if you want to run it manually or pass additional CLI flags. When you are finished, stop the container with `docker stop sdiloudness`.

> **Note:** If your Desktop Video installation stores `libDeckLinkAPI.so` in a different location (e.g. `/opt/BlackmagicDesktopVideo/lib64`), update the bind mount path accordingly. The container sets `LD_LIBRARY_PATH=/usr/lib/blackmagic` so that whatever you mount there is immediately discoverable.
