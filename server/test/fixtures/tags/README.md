These tiny fixtures contain a generated 440 Hz sine wave (0.15 seconds at 48 kHz),
not music from a user's library. They are checked in so CI needs no FFmpeg.

Generated with FFmpeg's lavfi sine source, using libmp3lame, flac, libopus, libvorbis and aac.
The MP3 includes both ID3v2.3 and ID3v1 tags to exercise clearing legacy values.
Tags include a full date, album artist, composer, comment, track/disc totals,
and a one-pixel PNG cover. FLAC/Ogg/Opus also have an ARTISTS alias, lyrics and
a custom Vorbis comment to exercise preservation of unrelated metadata.
