// netlify/functions/trains.js
// Fetches Metro-North GTFS-RT feed and returns upcoming Port Chester → GCT trains

const FEED_URL       = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr";
const STATION_NAME   = "Port Chester";
const STOP_ID        = "115";   // Confirmed Port Chester stop_id
const GCT_STOP_ID    = "1";     // Grand Central Terminal
const WALK_MINUTES   = 10;
const BUFFER_MINUTES = 2;

// ── Minimal protobuf decoder (no npm deps needed) ──────────────────────────
function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    b = buf[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return { value: result >>> 0, pos };
}

function parseMessage(bytes) {
  const result = {};
  let p = 0;
  while (p < bytes.length) {
    const tag = readVarint(bytes, p);
    if (tag.pos >= bytes.length && tag.value === 0) break;
    p = tag.pos;
    const fieldNum = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    if (wireType === 0) {
      const v = readVarint(bytes, p);
      p = v.pos;
      if (result[fieldNum] === undefined) result[fieldNum] = v.value;
    } else if (wireType === 1) {
      p += 8;
    } else if (wireType === 2) {
      const lenR = readVarint(bytes, p);
      p = lenR.pos;
      const chunk = bytes.slice(p, p + lenR.value);
      if (!result[fieldNum]) result[fieldNum] = [chunk];
      else result[fieldNum].push(chunk);
      p += lenR.value;
    } else if (wireType === 5) {
      p += 4;
    } else {
      break;
    }
  }
  return result;
}

function decodeStr(chunk) {
  if (!chunk) return "";
  const bytes = Array.isArray(chunk) ? chunk[0] : chunk;
  return new TextDecoder().decode(bytes);
}

function parseGtfsRt(buffer) {
  const u8 = new Uint8Array(buffer);
  const root = parseMessage(u8);
  const entityChunks = root[2] || [];
  const trains = [];
  const now = Math.floor(Date.now() / 1000);

  for (const ec of entityChunks) {
    const entity = parseMessage(ec);
    const tuChunks = entity[3];
    if (!tuChunks) continue;

    for (const tuChunk of (Array.isArray(tuChunks) ? tuChunks : [tuChunks])) {
      const tu = parseMessage(tuChunk);
      const tripChunk = tu[1] ? (Array.isArray(tu[1]) ? tu[1][0] : tu[1]) : null;
      const trip = tripChunk ? parseMessage(tripChunk) : {};
      const tripId  = decodeStr(trip[3]);
      const routeId = decodeStr(trip[5]);

      const stuChunks = tu[2] || [];
      const allStus = (Array.isArray(stuChunks) ? stuChunks : [stuChunks]).map(s => parseMessage(s));

      // Only inbound: last stop must be GCT
      const lastStu = allStus[allStus.length - 1];
      if (!lastStu || decodeStr(lastStu[3]) !== GCT_STOP_ID) continue;

      // Find Port Chester stop
      const pcIdx = allStus.findIndex(s => decodeStr(s[3]) === STOP_ID);
      if (pcIdx === -1) continue;

      const pcStu = allStus[pcIdx];

      // Get departure time
      let depTs = null;
      const depMsg = pcStu[3] ? parseMessage(Array.isArray(pcStu[3]) ? pcStu[3][0] : pcStu[3]) : null;
      const arrMsg = pcStu[2] ? parseMessage(Array.isArray(pcStu[2]) ? pcStu[2][0] : pcStu[2]) : null;
      if (depMsg && depMsg[2]) depTs = depMsg[2];
      else if (arrMsg && arrMsg[2]) depTs = arrMsg[2];

      if (!depTs || depTs < now - 300) continue;

      // Get GCT arrival
      let gctArr = null;
      const gctStu = allStus[allStus.length - 1];
      const gctArrMsg = gctStu[2] ? parseMessage(Array.isArray(gctStu[2]) ? gctStu[2][0] : gctStu[2]) : null;
      if (gctArrMsg && gctArrMsg[2]) gctArr = gctArrMsg[2];

      const lvTs = depTs - (WALK_MINUTES + BUFFER_MINUTES) * 60;

      trains.push({
        trip_id:          tripId,
        route_id:         routeId,
        dep_ts:           depTs,
        dep_time:         fmtTime(depTs),
        leave_ts:         lvTs,
        leave_time:       fmtTime(lvTs),
        leave_in_seconds: lvTs - now,
        gct_arr_ts:       gctArr,
        gct_arr_time:     gctArr ? fmtTime(gctArr) : null,
        stops_remaining:  allStus.length - pcIdx,
      });
    }
  }

  trains.sort((a, b) => a.dep_ts - b.dep_ts);
  return trains;
}

function fmtTime(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  let h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ── Handler ────────────────────────────────────────────────────────────────
export default async (req, context) => {
  try {
    const resp = await fetch(FEED_URL);
    if (!resp.ok) throw new Error(`MTA feed returned ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    const trains = parseGtfsRt(buffer);

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
