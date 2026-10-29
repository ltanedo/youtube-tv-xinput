# Generated playback fixture

`playback-fixture.mp4` is a 30-second synthetic color pattern and sine tone generated
for these tests; no external media is included. It is packaged only in the test APK.

Reproduce with FFmpeg:

```sh
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=15 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 30 -c:v libx264 -preset ultrafast -crf 35 -pix_fmt yuv420p -c:a aac -b:a 32k -movflags +faststart playback-fixture.mp4
```
