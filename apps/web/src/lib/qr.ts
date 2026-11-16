import { create } from "qrcode";

/** Modules of white border around the code; the QR spec asks for 4. */
const QUIET_ZONE = 4;

/**
 * A QR code as one SVG path (a unit square per dark module), so React renders
 * it as plain markup: crisp at any print size, no canvas, no innerHTML.
 * Error correction "M" survives a scuffed or partly covered poster.
 */
export function qrSvgPath(text: string): { viewBox: number; d: string } {
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  const parts: string[] = [];
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) {
        parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
      }
    }
  }
  return { viewBox: modules.size + QUIET_ZONE * 2, d: parts.join("") };
}
