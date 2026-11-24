// AVC and HEVC samples in Matroska and MP4 use length-prefixed NAL units.
function independentNalPicture(bytes, lengthSize, avc) {
  if (!bytes) return false;
  if (!(lengthSize >= 1 && lengthSize <= 4)) return false;
  for (let offset = 0; offset + lengthSize < bytes.length;) {
    let size = 0;
    for (let i = 0; i < lengthSize; i++) size = size * 256 + bytes[offset + i];
    offset += lengthSize;
    if (size <= 0 || offset + size > bytes.length) return false;
    const type = avc ? bytes[offset] & 31 : (bytes[offset] >> 1) & 63;
    if (avc ? type === 5 : type >= 16 && type <= 21) return true;
    offset += size;
  }
  return false;
}
if (typeof module !== "undefined" && module.exports) module.exports = independentNalPicture;
