These tiny fixtures contain a generated 440 Hz sine wave (0.15 seconds at 48 kHz),
not music from a user's library. They are checked in so CI needs no FFmpeg.

Generated with FFmpeg's lavfi sine source, using libmp3lame, flac, libopus, libvorbis and aac.
The MP3 includes both ID3v2.3 and ID3v1 tags to exercise clearing legacy values.
Tags include a full date, album artist, composer, comment, track/disc totals,
and a one-pixel PNG cover. FLAC/Ogg/Opus also have an ARTISTS alias, lyrics and
a custom Vorbis comment to exercise preservation of unrelated metadata.

The WAV, WMA and AAC fixtures are 0.2-second synthetic 440 Hz tones generated with FFmpeg. They contain no third-party recordings and exercise the RIFF, ASF and ADTS tag writers. Tests compare encoded audio payloads before and after tag edits.

`duration-30s.opus` is a 30-second synthetic 440 Hz tone at 48 kHz, encoded with
libopus at 24 kbps. Its final Ogg page lies beyond the metadata parser's default
early-stop threshold. It tests duration extraction and repair of existing zeros;
the short fixtures above do not reach that threshold. Reproduce it with:

```bash
ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i sine=frequency=440:sample_rate=48000 -t 30 -c:a libopus -b:a 24k -metadata title='Opus duration regression' -metadata artist='Duration test artist' -metadata album='Duration test album' duration-30s.opus
```
