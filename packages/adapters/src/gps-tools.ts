/**
 * GPS capture: the last location a person shared in a Space's messaging chat,
 * with how old it is. The tool never guesses a location and never invents an
 * age; no receipt answers `no_location_captured` instead.
 */

/** The one reason the tool has no location: nobody shared one in this Space. */
export const GPS_NO_LOCATION_REASON = "no_location_captured";

/** A receipt already read from the messaging receipts table. */
export interface GpsLocationRow {
  latitude: number;
  longitude: number;
  label: string | null;
  capturedAt: Date;
}

export interface GpsAvailable {
  available: true;
  location: { latitude: number; longitude: number; label?: string };
  /** Whole minutes since the platform reported it; 0 under a minute. */
  staleMinutes: number;
  capturedAt: string;
}

export interface GpsUnavailable {
  available: false;
  reason: typeof GPS_NO_LOCATION_REASON;
}

export type GpsResult = GpsAvailable | GpsUnavailable;

/** What the tool reads: one query, one answer. */
export interface GpsReceiptReader {
  latestLocation(input: { spaceId: string }): Promise<GpsLocationRow | null>;
}

export interface GpsDispatchDeps {
  receipts: GpsReceiptReader;
  /** The run's own Space; the only Space the tool may read. */
  spaceId: string;
  now?: Date;
}

/** Turn a receipt row (or its absence) into the tool's result. */
export function gpsResultFrom(row: GpsLocationRow | null, now: Date = new Date()): GpsResult {
  if (!row) return { available: false, reason: GPS_NO_LOCATION_REASON };
  const staleMinutes = Math.max(0, Math.floor((now.getTime() - row.capturedAt.getTime()) / 60_000));
  return {
    available: true,
    location: {
      latitude: row.latitude,
      longitude: row.longitude,
      ...(row.label ? { label: row.label } : {}),
    },
    staleMinutes,
    capturedAt: row.capturedAt.toISOString(),
  };
}

/**
 * Dispatch the `me_gps` call. A Space other than the run's own is refused with
 * the same not-available shape, so a caller cannot probe another Space.
 */
export async function dispatchGpsTool(
  args: { spaceId?: unknown },
  deps: GpsDispatchDeps,
): Promise<GpsResult> {
  if (typeof args.spaceId === "string" && args.spaceId.trim() !== deps.spaceId) {
    return { available: false, reason: GPS_NO_LOCATION_REASON };
  }
  return gpsResultFrom(await deps.receipts.latestLocation({ spaceId: deps.spaceId }), deps.now);
}
