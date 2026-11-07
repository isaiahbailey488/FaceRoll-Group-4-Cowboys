'use strict';

/** Oval bounds in the full camera viewport, independent of screen content. */
function faceGuideFrame(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError('A positive camera viewport is required.');
  }
  const top = Math.min(Math.max(196, height * 0.22), height * 0.35);
  const controlsSpace = Math.min(208, height * 0.36);
  const maxHeight = height - top - controlsSpace;
  const ovalWidth = Math.min(width * 0.55, maxHeight / 1.3, 320);
  return { left: (width - ovalWidth) / 2, top, width: ovalWidth, height: ovalWidth * 1.3 };
}

module.exports = { faceGuideFrame };
