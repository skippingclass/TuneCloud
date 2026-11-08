import fs from 'node:fs';
import { File, TagTypes, AsfHeaderObject, FileAccessMode, ByteVector } from 'node-taglib-sharp';

export const EDITABLE_TAG_FORMATS = ['mp3', 'flac', 'ogg', 'opus', 'm4a', 'wav', 'wma', 'aac'];

function saveAsfTags(file, filePath) {
  // node-taglib-sharp 6.0.3 replaces the NEW header length rather than the
  // original length in AsfFile.save(), overwriting audio when tags grow.
  file.mode = FileAccessMode.Write;
  try {
    const header = AsfHeaderObject.fromFile(file, 0);
    header.addUniqueObject(file.tag.contentDescriptionObject);
    header.addUniqueObject(file.tag.extendedContentDescriptionObject);
    header.extension?.addUniqueObject(file.tag.metadataLibraryObject);
    const bytes = Buffer.from(header.render().toByteArray());
    const properties = bytes.indexOf(Buffer.from('a1dcab8c47a9cf118ee400c00c205365', 'hex'));
    if (properties < 0) throw new Error('ASF file properties missing');
    bytes.writeBigUInt64LE(BigInt(fs.statSync(filePath).size + bytes.length - header.originalSize), properties + 40);
    file.insert(ByteVector.fromByteArray(bytes), 0, header.originalSize);
  } finally { file.mode = FileAccessMode.Closed; }
}

// The staged file ends in .tmp, so always use the original file's format.
export function writeAudioTags(filePath, format, updates) {
  if (!EDITABLE_TAG_FORMATS.includes(format)) throw new Error('Unsupported tag format');
  const file = File.createFromPath(filePath, `taglib/${format === 'wma' ? 'asf' : format}`);
  try {
    for (const field of ['title', 'album']) if (updates[field] !== undefined) file.tag[field] = updates[field];
    if (updates.genre !== undefined) file.tag.genres = updates.genre ? [updates.genre] : [];
    if (updates.genres !== undefined) file.tag.genres = updates.genres;
    if (updates.albumArtist !== undefined) file.tag.albumArtists = updates.albumArtist ? [updates.albumArtist] : [];
    if (updates.composer !== undefined) file.tag.composers = updates.composer ? [updates.composer] : [];
    if (updates.musicBrainzId !== undefined) file.tag.musicBrainzTrackId = updates.musicBrainzId;
    if (updates.albumMusicBrainzId !== undefined) file.tag.musicBrainzReleaseId = updates.albumMusicBrainzId;
    if (updates.discNumber !== undefined) file.tag.disc = updates.discNumber || 0;
    if (updates.discTotal !== undefined) file.tag.discCount = updates.discTotal || 0;
    if (updates.compilation !== undefined) file.tag.isCompilation = updates.compilation;
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
    if (format === 'wma') saveAsfTags(file, filePath);
    else file.save();
  } finally {
    file.dispose();
  }
}
