import { crc32, inflateSync } from "node:zlib";

import type {
  CompareWebScreenshotsInput,
  WebScreenshotArtifact,
  WebScreenshotDiff,
} from "../domain/webScreenshot.js";
import { AnalysisUnsupportedTargetError } from "../domain/analysisErrorCore.js";
import { decodeCanonicalBase64 } from "../domain/webScreenshot.js";

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Buffer;
}

/** Compare two validated screenshots using deterministic RGBA metrics. */
export const comparePngScreenshots = (
  input: CompareWebScreenshotsInput,
): WebScreenshotDiff => {
  const before = decodePng(input.before, "before");
  const after = decodePng(input.after, "after");
  if (before.width !== after.width || before.height !== after.height)
    return {
      status: "dimension_mismatch",
      before: dimensions(before),
      after: dimensions(after),
      channel_threshold: input.channel_threshold,
      compared_pixels: 0,
      changed_pixels: null,
      changed_ratio: null,
      maximum_channel_delta: null,
      mean_absolute_channel_delta: null,
      limitations: limitations(),
    };
  let changedPixels = 0;
  let maximumDelta = 0;
  let totalDelta = 0;
  for (let offset = 0; offset < before.rgba.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        (before.rgba[offset + channel] ?? 0) -
          (after.rgba[offset + channel] ?? 0),
      );
      totalDelta += delta;
      maximumDelta = Math.max(maximumDelta, delta);
      if (delta > input.channel_threshold) changed = true;
    }
    if (changed) changedPixels += 1;
  }
  const pixels = before.width * before.height;
  const context = {
    before: dimensions(before),
    after: dimensions(after),
    channel_threshold: input.channel_threshold,
    compared_pixels: pixels,
    maximum_channel_delta: maximumDelta,
    mean_absolute_channel_delta: totalDelta / (pixels * 4),
    limitations: limitations(),
  };
  if (changedPixels === 0)
    return {
      ...context,
      status: "identical",
      changed_pixels: 0,
      changed_ratio: 0,
    };
  return {
    ...context,
    status: "different",
    changed_pixels: changedPixels,
    changed_ratio: changedPixels / pixels,
  };
};

const decodePng = (
  artifact: WebScreenshotArtifact,
  field: "before" | "after",
): DecodedPng => {
  const bytes = decodeCanonicalBase64(artifact.data_base64);
  if (bytes === undefined || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new TypeError("Invalid PNG signature");
  let offset = 8;
  let header: ReturnType<typeof parseHeader> | undefined;
  const compressed: Buffer[] = [];
  let sawEnd = false;
  let sawPalette = false;
  let imageDataEnded = false;
  let paletteEntries = 0;
  let transparentColor: readonly number[] | undefined;
  let sawTransparency = false;
  let unsupportedReason: string | undefined;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new TypeError("Truncated PNG chunk");
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff) throw new TypeError("Invalid PNG chunk length");
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new TypeError("Truncated PNG data");
    const data = bytes.subarray(dataStart, dataEnd);
    if (
      crc32(bytes.subarray(offset + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)
    )
      throw new TypeError("Invalid PNG chunk checksum");
    if (!/^[A-Za-z]{4}$/u.test(type) || type[2] !== type[2]?.toUpperCase())
      throw new TypeError("Invalid PNG chunk type");
    if (type !== "IDAT" && compressed.length > 0) imageDataEnded = true;
    if (type === "IHDR") {
      if (offset !== 8 || header !== undefined)
        throw new TypeError("Invalid PNG header order");
      header = parseHeader(data);
    } else if (header === undefined)
      throw new TypeError("Invalid PNG header order");
    else if (type === "tRNS") {
      if (sawTransparency || compressed.length > 0)
        throw new TypeError("Invalid PNG transparency order");
      sawTransparency = true;
      if (header.colorType === 2 && data.length === 6) {
        transparentColor = [
          data.readUInt16BE(0),
          data.readUInt16BE(2),
          data.readUInt16BE(4),
        ];
      } else if (
        (header.colorType === 0 && data.length === 2) ||
        (header.colorType === 3 &&
          sawPalette &&
          data.length > 0 &&
          data.length <= paletteEntries)
      ) {
        unsupportedReason ??=
          "PNG transparency for this color type is not supported.";
      } else {
        throw new TypeError("Unsupported PNG transparency");
      }
    } else if (type === "PLTE") {
      if (
        sawPalette ||
        sawTransparency ||
        compressed.length > 0 ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0 ||
        (header.colorType === 3 && length / 3 > 2 ** header.bitDepth) ||
        (header.colorType !== 2 &&
          header.colorType !== 3 &&
          header.colorType !== 6)
      )
        throw new TypeError("Invalid PNG palette");
      sawPalette = true;
      paletteEntries = length / 3;
    } else if (type === "IDAT") {
      if (imageDataEnded) throw new TypeError("Nonconsecutive PNG image data");
      compressed.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || dataEnd + 4 !== bytes.length)
        throw new TypeError("Invalid PNG end chunk");
      sawEnd = true;
      break;
    } else if (/^[A-Z]/u.test(type)) {
      unsupportedReason ??= `Unsupported critical PNG chunk ${type}.`;
    }
    offset = dataEnd + 4;
  }
  if (header === undefined || !sawEnd || compressed.length === 0)
    throw new TypeError("Incomplete PNG");
  if (header.colorType === 3 && !sawPalette)
    throw new TypeError("Missing PNG palette");
  if (unsupportedReason !== undefined)
    throw new AnalysisUnsupportedTargetError(
      "compare_web_screenshots",
      field,
      unsupportedReason,
    );
  if (!header.supported)
    throw new AnalysisUnsupportedTargetError(
      "compare_web_screenshots",
      field,
      "PNG encoding is not supported for pixel comparison.",
    );
  const rowBytes = header.width * header.channels;
  const expected = (rowBytes + 1) * header.height;
  const raw = inflatePng(Buffer.concat(compressed), expected + 1);
  if (raw.byteLength !== expected) throw new TypeError("Unexpected PNG size");
  return {
    width: header.width,
    height: header.height,
    rgba: expandRgba(
      unfilter(raw, header.width, header.height, header.channels),
      header.channels,
      transparentColor,
    ),
  };
};

const inflatePng = (compressed: Buffer, maxOutputLength: number): Buffer => {
  try {
    return inflateSync(compressed, { maxOutputLength });
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "Z_DATA_ERROR" ||
        cause.code === "Z_BUF_ERROR" ||
        cause.code === "ERR_BUFFER_TOO_LARGE")
    )
      throw new TypeError("Invalid PNG image data", { cause });
    throw cause;
  }
};

const parseHeader = (data: Buffer) => {
  if (data.byteLength !== 13) throw new TypeError("Invalid PNG header");
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8] ?? 0;
  const colorType = data[9] ?? -1;
  const safePixelCount =
    BigInt(width) * BigInt(height) <= BigInt(Number.MAX_SAFE_INTEGER);
  const validDepth =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && [8, 16].includes(bitDepth)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    (colorType === 4 && [8, 16].includes(bitDepth)) ||
    (colorType === 6 && [8, 16].includes(bitDepth));
  if (
    width === 0 ||
    height === 0 ||
    width > 0x7fffffff ||
    height > 0x7fffffff ||
    !validDepth ||
    data[10] !== 0 ||
    data[11] !== 0 ||
    (data[12] !== 0 && data[12] !== 1)
  )
    throw new TypeError("Invalid PNG header");
  return {
    width,
    height,
    colorType,
    bitDepth,
    interlace: data[12],
    channels: colorType === 6 ? 4 : 3,
    supported:
      safePixelCount &&
      bitDepth === 8 &&
      (colorType === 2 || colorType === 6) &&
      data[12] === 0,
  };
};

const unfilter = (
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
): Buffer => {
  const rowBytes = width * channels;
  const decoded = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (rowBytes + 1);
    const outputOffset = row * rowBytes;
    const filter = raw[rawOffset];
    if (filter === undefined || filter > 4)
      throw new TypeError("Unsupported PNG filter");
    for (let column = 0; column < rowBytes; column += 1) {
      const source = raw[rawOffset + 1 + column] ?? 0;
      const left =
        column >= channels
          ? (decoded[outputOffset + column - channels] ?? 0)
          : 0;
      const above =
        row > 0 ? (decoded[outputOffset + column - rowBytes] ?? 0) : 0;
      const upperLeft =
        row > 0 && column >= channels
          ? (decoded[outputOffset + column - rowBytes - channels] ?? 0)
          : 0;
      decoded[outputOffset + column] = applyFilter({
        filter,
        source,
        left,
        above,
        upperLeft,
      });
    }
  }
  return decoded;
};

const expandRgba = (
  decoded: Buffer,
  channels: number,
  transparentColor: readonly number[] | undefined,
): Buffer => {
  if (channels === 4) return decoded;
  const rgba = Buffer.alloc((decoded.length / channels) * 4);
  for (
    let source = 0, target = 0;
    source < decoded.length;
    source += 3, target += 4
  ) {
    rgba[target] = decoded[source] ?? 0;
    rgba[target + 1] = decoded[source + 1] ?? 0;
    rgba[target + 2] = decoded[source + 2] ?? 0;
    // PNG tRNS keys are 16-bit values; values above 255 cannot match 8-bit samples.
    rgba[target + 3] =
      transparentColor !== undefined &&
      transparentColor.every(
        (value, channel) => decoded[source + channel] === value,
      )
        ? 0
        : 255;
  }
  return rgba;
};

interface ApplyFilterOptions {
  readonly filter: number;
  readonly source: number;
  readonly left: number;
  readonly above: number;
  readonly upperLeft: number;
}

const applyFilter = (options: ApplyFilterOptions): number => {
  const { filter, source, left, above, upperLeft } = options;
  switch (filter) {
    case 0:
      return source;
    case 1:
      return (source + left) & 0xff;
    case 2:
      return (source + above) & 0xff;
    case 3:
      return (source + Math.floor((left + above) / 2)) & 0xff;
    case 4:
      return (source + paeth(left, above, upperLeft)) & 0xff;
    default:
      throw new TypeError("Unsupported PNG filter");
  }
};

const paeth = (left: number, above: number, upperLeft: number): number => {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance
      ? above
      : upperLeft;
};

const dimensions = ({ width, height }: DecodedPng) => ({ width, height });

const limitations = (): string[] => [
  "Pixel comparison does not perform OCR, semantic layout analysis, or perceptual color correction.",
  "Only non-interlaced 8-bit RGB and RGBA PNG screenshots are accepted.",
  "PNG tRNS transparency is accepted only as a six-byte RGB color key; tRNS on RGBA or with another length is rejected.",
];

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
