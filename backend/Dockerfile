FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    libgdal-dev \
    libcurl4-openssl-dev \
    nlohmann-json3-dev \
    libasio-dev \
    wget \
    && rm -rf /var/lib/apt/lists/*

RUN wget -q https://github.com/CrowCpp/Crow/releases/latest/download/crow_all.h -O /usr/local/include/crow_all.h

WORKDIR /app
COPY . /app
EXPOSE 9091