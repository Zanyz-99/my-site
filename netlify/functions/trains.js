// netlify/functions/trains.js

const FEED_URL       = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr";
const STATION_NAME   = "Port Chester";
const STOP_ID        = "115";
const GCT_STOP_ID    = "1";
const WALK_MINUTES   = 10;
const BUFFER_MINUTES = 2;

const td = new TextDecoder();

// ── Low-level protobuf primitives ─────────────────────────────────────────────
function varint(u8, pos) {
  let val = 0, shift = 0, b;
  do { b = u8[pos++]; val |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return [val >>> 0, pos];
}

function skipField(u8, pos, wt) {
  if (wt === 0) { let b; do { b = u8[pos++]; } while (b & 0x80); }
  else if (wt === 1) pos += 8;
  else if (wt === 2) { const [len, p] = varint(u8, pos); pos = p + len; }
  else if (wt === 5) pos += 4;
  return pos;
}

// Parse a flat message, returning a map of fieldNum -> array of {wt, pos, len}
function scanMsg(u8, start, end) {
  const fields = {};
  let pos = start;
  while (pos < end) {
    const [tag, p1] = varint(u8, pos);
    const f = tag >>> 3, wt = tag & 7;
    pos = p1;
    if (wt === 2) {
      const [len, p2] = varint(u8, pos);
      if (!fields[f]) fields[f] = [];
      fields[f].push({ pos: p2, len });
      pos = p2 + len;
    } else {
      pos = skipField(u8, pos, wt);
    }
  }
  return fields;
}

function getString(u8, ref) {
  return td.decode(u8.slice(ref.pos, ref.pos + ref.len));
}

function getVarintField(u8, ref, fieldNum) {
  const msg = scanMsg(u8, ref.pos, ref.pos + ref.len);
  if (!msg[fieldNum]) return 0;
  const [val] = varint(u8, msg[fieldNum][0].pos);
  return val;
}

// ── GTFS-RT parser ────────────────────────────────────────────────────────────
function parseGtfsRt(buffer) {
  const u8   = new Uint8Array(buffer);
  const now  = Math.floor(Date.now() / 1000);
  const root = scanMsg(u8, 0, u8.length);
  const trains = [];

  for (const entityRef of (root[2] || [])) {
    const entity = scanMsg(u8, entityRef.pos, entityRef.pos + entityRef.len);
    if (!entity[3]) continue;                          // no trip_update

    const tu = scanMsg(u8, entity[3][0].pos, entity[3][0].pos + entity[3][0].len);

    // Trip descriptor (field 1): trip_id=field 1, route_id=field 5
    let tripId = "", routeId = "";
    if (tu[1]) {
      const trip = scanMsg(u8, tu[1][0].pos, tu[1][0].pos + tu[1][0].len);
      if (trip[1]) tripId  = getString(u8, trip[1][0]);
      if (trip[5]) routeId = getString(u8, trip[5][0]);
    }

    // StopTimeUpdates (field 2, repeated)
    const stuRefs = tu[2] || [];
    const stops = [];

    for (const stuRef of stuRefs) {
      const stu = scanMsg(u8, stuRef.pos, stuRef.pos + stuRef.len);

      // stop_id: field 4 (primary) or field 3 if it's a string
      let stopId = "";
      if (stu[4]) {
        stopId = getString(u8, stu[4][0]);
      } else if (stu[3]) {
        // field 3 could be stop_id (string) or departure (message)
        // Check: if first byte parses as a valid tag with field 1-3 and wt 0, it's a message
        const ref = stu[3][0];
        const firstByte = u8[ref.pos];
        const innerField = firstByte >>> 3;
        const innerWt    = firstByte & 7;
        if (innerField >= 1 && innerField <= 4 && innerWt === 0) {
          // looks like a StopTimeEvent message — skip as departure, stopId stays ""
        } else {
          stopId = getString(u8, ref);
        }
      }

      // arrival (field 2) -> time (field 2 inside)
      const arrTs = stu[2] ? getVarintField(u8, stu[2][0], 2) : 0;
      // departure (field 3) -> time (field 2 inside) — only if it's a message
      let depTs = 0;
      if (stu[3]) {
        const ref = stu[3][0];
        const firstByte = u8[ref.pos];
        const innerField = firstByte >>> 3;
        const innerWt    = firstByte & 7;
        if (innerField >= 1 && innerField <= 4 && innerWt === 0) {
          depTs = getVarintField(u8, ref, 2);
        }
      }

      stops.push({ stopId, arrTs, depTs });
    }

    if (!stops.length) continue;
    if (stops[stops.length - 1].stopId !== GCT_STOP_ID) continue;

    const pcIdx = stops.findIndex(s => s.stopId === STOP_ID);
    if (pcIdx < 0) continue;

    const pc    = stops[pcIdx];
    const depTs = pc.depTs || pc.arrTs;
    if (!depTs) continue;

    const gctArr = stops[stops.length - 1].arrTs || stops[stops.length - 1].depTs || null;
    const lvTs   = depTs - (WALK_MINUTES + BUFFER_MINUTES) * 60;

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
      stops_remaining:  stops.length - pcIdx,
    });
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

export default async () => {
  try {
    const resp = await fetch(FEED_URL);
    if (!resp.ok) throw new Error(`MTA feed returned ${resp.status}`);
    const trains = parseGtfsRt(await resp.arrayBuffer());
    return new Response(JSON.stringify({
      status: "ok", station: STATION_NAME, stop_id: STOP_ID,
      walk_minutes: WALK_MINUTES, buffer_minutes: BUFFER_MINUTES,
      trains, updated: new Date().toISOString(),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/trains" };
