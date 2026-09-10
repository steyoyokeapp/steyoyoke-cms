import type { MediaAsset, MediaVariant } from "@/generated/prisma/client";

export type LegacyMediaSource = (MediaAsset & { variants?: MediaVariant[] }) | null | undefined;

export const LEGACY_VARIANT_PATHS = {
  ORIGINAL: "", LEGACY_1440: "1440/", LEGACY_1024: "1024/", LEGACY_512: "512/",
  LEGACY_THUMB_256: "thumbnails/256/", LEGACY_THUMB_80: "thumbnails/80/",
} as const;

export class LegacyMediaSerializer {
  static path(asset: LegacyMediaSource, variant: keyof typeof LEGACY_VARIANT_PATHS) {
    if (!asset || asset.status !== "READY") return null;
    return `/assets/uploads/files/${LEGACY_VARIANT_PATHS[variant]}${asset.compatibilityFilename}`;
  }

  static covers(asset: LegacyMediaSource) {
    return {
      cover_download: this.path(asset, "ORIGINAL"),
      cover_thumbnail_low: this.path(asset, "LEGACY_THUMB_256"),
      cover_thumbnail_high: this.path(asset, "LEGACY_512"),
      cover_low: this.path(asset, "LEGACY_1024"),
      cover_high: this.path(asset, "LEGACY_1440"),
    };
  }
}
