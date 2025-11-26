FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# --- Base tools and NodeSource repo for Node.js 20 ---
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list

# --- Build dependencies ---
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    git \
    nodejs \
    pkg-config \
    python3 \
    libavcodec-dev \
    libavdevice-dev \
    libavfilter-dev \
    libavformat-dev \
    libavutil-dev \
    libswscale-dev \
    libswresample-dev \
    libfftw3-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# The DeckLink runtime libraries will be bind-mounted here from the host.
ENV LD_LIBRARY_PATH=/usr/lib/blackmagic:${LD_LIBRARY_PATH}
RUN mkdir -p /usr/lib/blackmagic

# --- Install Node dependencies (cached layer) ---
COPY package*.json ./
RUN npm ci --omit=dev

# --- Copy the rest of the project ---
COPY . .

# --- Build libdatachannel and the Capture binary ---
RUN rm -rf libs/libdatachannel/build libs/libdatachannel/install && \
    git -C libs/libdatachannel submodule update --init --recursive && \
    cmake -S libs/libdatachannel -B libs/libdatachannel/build \
        -DNO_MEDIA=OFF \
        -DNO_WEBSOCKET=OFF \
        -DPREFER_SYSTEM_LIB=OFF \
        -DCMAKE_INSTALL_PREFIX=${PWD}/libs/libdatachannel/install \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF && \
    cmake --build libs/libdatachannel/build --config Release && \
    cmake --install libs/libdatachannel/build --config Release && \
    make video

EXPOSE 8080

# The Node server launches the Capture binary internally.
CMD ["node", "server.js"]
