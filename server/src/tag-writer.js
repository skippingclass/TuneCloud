import { File, TagTypes } from 'node-taglib-sharp';

export const EDITABLE_TAG_FORMATS = ['mp3', 'flac', 'ogg', 'opus', 'm4a'];

// The staged file ends in .tmp, so always use the original file's format.
export function writeAudioTags(filePath, format, updates) {
  if (!EDITABLE_TAG_FORMATS.includes(format)) throw new Error('Unsupported tag format');
  const file = File.createFromPath(filePath, `taglib/${format}`);
  try {
    for (const field of ['title', 'album']) if (updates[field] !== undefined) file.tag[field] = updates[field];
    if (updates.genre !== undefined) file.tag.genres = updates.genre ? [updates.genre] : [];
    if (updates.year !== undefined) file.tag.year = updates.year || 0;
    if (updates.trackNumber !== undefined) file.tag.track = updates.trackNumber || 0;
    if (updates.artist !== undefined) {
      const artists = updates.artist ? [updates.artist] : [];
      file.tag.performers = artists;
      // Some taggers store both ARTIST and ARTISTS. music-metadata reads both;
      // keep them consistent, including explicit clearing, without touching album artists.
      const xiph = file.getTag(TagTypes.Xiph, false);
      if (xiph) xiph.setFieldAsStrings('ARTISTS', ...artists);
    }
    file.save();
  } finally {
    file.dispose();
  }
}
