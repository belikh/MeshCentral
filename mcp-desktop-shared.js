'use strict';

/**
 * @description Helpers shared by the MeshCentral desktop tool families.
 *
 * The snapshot, frames and input tools translate the same imageType, quality
 * and scale arguments into session options, render the same frame metadata
 * and surface relay denials the same way. These helpers hold that shape in
 * one place, so each tool family changes for one reason.
 *
 * @author Jupiter Belic
 * @license Apache-2.0
 */

const { DesktopCaptureError, IMAGE_TYPES } = require('./desktopcapture.js');

const IMAGE_TYPE_NAMES = ['jpeg', 'png', 'tiff', 'webp'];

/** Render the frame metadata that accompanies the image block. */
function formatFrameMetadata(frame) {
    const resolution = ((frame.width != null) && (frame.height != null)) ? (frame.width + 'x' + frame.height) : 'unknown resolution';
    const format = (frame.mimeType != null) ? frame.mimeType : 'unknown format';
    const frameIndex = (frame.index != null) ? frame.index : 'unknown';
    const timestamp = (frame.timestamp != null) ? new Date(frame.timestamp).toISOString() : 'unknown time';
    return 'resolution ' + resolution + ', format ' + format + ', frame ' + frameIndex + ', captured ' + timestamp;
}

// When the relay reported a denial before closing, prefer its own words over
// the generic transport message the viewer synthesised around them. Client
// errors (authentication, launch denials) keep their actionable messages.
function surfaceCaptureError(error) {
    if ((error instanceof DesktopCaptureError) && (typeof error.serverMessage === 'string') && (error.serverMessage.length > 0)) {
        return new Error(error.serverMessage);
    }
    return error;
}

// Translate the shared imageType/quality/scale arguments into session options.
// Explicit call arguments win over the bridge's configured defaults; without
// either, the option is left unset so the capture module's own defaults apply.
// The same options feed the snapshot launch, the input launch and the frames
// cache, so every session opened by these tools honours the defaults.
function sessionOptionsFrom(args, defaults) {
    defaults = defaults || {};
    const sessionOptions = {};
    const imageType = (args.imageType !== undefined) ? args.imageType : defaults.imageType;
    if (imageType !== undefined) { sessionOptions.imageType = IMAGE_TYPES[imageType]; }
    const quality = (args.quality !== undefined) ? args.quality : defaults.quality;
    if (quality !== undefined) { sessionOptions.compression = quality; }
    const scale = (args.scale !== undefined) ? args.scale : defaults.scale;
    if (scale !== undefined) { sessionOptions.scaling = scale; }
    return sessionOptions;
}

module.exports = {
    IMAGE_TYPE_NAMES: IMAGE_TYPE_NAMES,
    formatFrameMetadata: formatFrameMetadata,
    surfaceCaptureError: surfaceCaptureError,
    sessionOptionsFrom: sessionOptionsFrom
};
