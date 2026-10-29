#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK directory}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/28.0.13004108}"
export CARGO_TARGET_DIR="$PWD/blocker/target"
IFS=',' read -ra abis <<< "${1:-arm64-v8a,armeabi-v7a,x86_64}"
args=()
for abi in "${abis[@]}"; do args+=(-t "$abi"); done
output="$PWD/app/build/generated/jniLibs"
cd blocker
cargo ndk "${args[@]}" --platform 26 -o "$output" build --locked --release
