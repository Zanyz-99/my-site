// netlify/functions/trains.js
import { FeedMessage } from "gtfs-realtime-bindings";

const FEED_URL       = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr";
const STATION_NAME   = "Port Chester";
const STOP_ID        = "115";  // Confirmed Port Chester stop_id (New Haven Line)
const GCT_STOP_ID    = "1";    // Grand Central Terminal
const WALK_MINUTES   = 10;
const BUFFER_MINUTES = 2;

function fmtTime(ts) {
  if (!ts) return null;
  const d = new Date(Number(ts) * 1000);
  let h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default async (req) => {
  try {
    const resp = await fetch(FEED_URL);
    if (!resp.ok) throw new Error(`MTA feed returned ${resp.status}`);

    const buffer = await resp.arrayBuffer();
    const feed = FeedMessage.decode(new Uint8Array(buffer));

    const now = Math.floor(Date.now() / 1000);
    const trains = [];

    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu) continue;

      const allStops = tu.stopTimeUpdate;
      if (!allStops || allStops.length === 0) continue;

      // Only inbound: last stop must be GCT
      const lastStop = allStops[allStops.length - 1];
      if (lastStop.stopId !== GCT_STOP_ID) continue;

      // Find Port Chester
      const pcIdx = allStops.findIndex(s => s.stopId === STOP_ID);
      if (pcIdx === -1) continue;

      const pcStop = allStops[pcIdx];

      // Get departure time (fall back to arrival)
      const depTs = Number(pcStop.departure?.time || pcStop.arrival?.time || 0);
      if (!depTs || depTs < now - 300) continue;

      // GCT arrival
      const gctArr = Number(lastStop.arrival?.time || lastStop.departure?.time || 0) || null;

      const lvTs = depTs - (WALK_MINUTES + BUFFER_MINUTES) * 60;

      trains.push({
        trip_id:          tu.trip.tripId,
        route_id:         tu.trip.routeId,
        dep_ts:           depTs,
        dep_time:         fmtTime(depTs),
        leave_ts:         lvTs,
        leave_time:       fmtTime(lvTs),
        leave_in_seconds: lvTs - now,
        gct_arr_ts:       gctArr,
        gct_arr_time:     gctArr ? fmtTime(gctArr) : null,
        stops_remaining:  allStops.length - pcIdx,
      });
    }

    trains.sort((a, b) => a.dep_ts - b.dep_ts);

    return new Response(JSON.stringify({
      status:         "ok",
      station:        STATION_NAME,
      stop_id:        STOP_ID,
      walk_minutes:   WALK_MINUTES,
      buffer_minutes: BUFFER_MINUTES,
      trains,
      updated:        new Date().toISOString(),
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/trains" };
