Desktop beta built by the **Desktop beta** workflow from this tag.

- **Windows x64** and **Windows ARM64** installers (`.msi`), plus a portable `.exe` for each.
- **Linux x64**:
  - `YouTubeTV-<version>-Linux-x64.deb` for Ubuntu 24.04+ / Debian 13+: `sudo apt install ./YouTubeTV-<version>-Linux-x64.deb`
  - `YouTubeTV-<version>-Linux-x64.pkg.tar.zst` for Arch Linux and derivatives such as Omarchy: `sudo pacman -U YouTubeTV-<version>-Linux-x64.pkg.tar.zst`
  - `YouTubeTV-<version>-Linux-x64.AppImage` for any other distribution (WebKitGTK and GStreamer bundled; needs glibc 2.39+ and FUSE 2, or run it with `--appimage-extract-and-run`): `chmod +x` it and run.

  Game controllers are read natively (evdev); see the README's Linux notes for Wayland, NVIDIA and controller troubleshooting.
- Verify downloads against `SHA256SUMS.txt`.
- macOS builds are not produced by this workflow; see the README for building the Apple Silicon app from source.

What's new is in the pull request linked from the tag's commit.
