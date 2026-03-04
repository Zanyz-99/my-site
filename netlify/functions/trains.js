// netlify/functions/trains.js
// GTFS-RT field layout (confirmed from protobuf descriptor):
// StopTimeUpdate: field 1=stop_sequence, field 2=arrival, field 3=departure, field 4=stop_id
// StopTimeEvent:  field 1=delay, field 2=time, field 3=uncertainty
// TripUpdate:     field 1=trip, field 2=stop_time_update (repeated)
// TripDescriptor: field 1=trip_id, field 3=route_id (wait - check)
// FeedMessage:    field 1=header, field 2=entity (repeated)
// FeedEntity:     field 1=id, field 2=is_deleted, field 3=trip_update

const FEED_URL       = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr";
const STATION_NAME   = "Port Chester";
const STOP_ID        = "115";
const GCT_STOP_ID    = "1";
const WALK_MINUTES   = 10;
const BUFFER_MINUTES = 2;

const td = new TextDecoder();

function varint(u8, pos) {
  let val = 0, shift = 0, b;
  do { b = u8[pos++]; val |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return [val >>> 0, pos];
}

// Scan a protobuf message from start to end.
// Returns { fieldNum: [{pos, len}] } for length-delimited fields only.
// Scalar fields are stored as { fieldNum: [value] }.
function scanMsg(u8, start, end) {
  const fields = {};
  let pos = start;
  while (pos < end) {
    if (pos >= u8.length) break;
    const [tag, p1] = varint(u8, pos);
    pos = p1;
    const f = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const [val, p2] = varint(u8, pos);
      pos = p2;
      if (!fields[f]) fields[f] = [];
      fields[f].push(val);
    } else if (wt === 1) {
      pos += 8;
    } else if (wt === 2) {
      const [len, p2] = varint(u8, pos);
      pos = p2;
      if (!fields[f]) fields[f] = [];
      fields[f].push({ pos: p2, len });
      pos = p2 + len;
    } else if (wt === 5) {
      pos += 4;
    } else {
      break; // unknown wire type, bail
    }
  }
  return fields;
}

function str(u8, ref) {
  return td.decode(u8.slice(ref.pos, ref.pos + ref.len));
}

// Get a scalar varint field from inside a length-delimited message ref
function scalarIn(u8, ref, fieldNum) {
  const inner = scanMsg(u8, ref.pos, ref.pos + ref.len);
  if (!inner[fieldNum] || !inner[fieldNum].length) return 0;
  const v = inner[fieldNum][0];
  return typeof v === 'number' ? v : 0;
}

function parseGtfsRt(buffer) {
  const u8   = new Uint8Array(buffer);
  const now  = Math.floor(Date.now() / 1000);
  const root = scanMsg(u8, 0, u8.length);
  const trains = [];

  for (const entityRef of (root[2] || [])) {
    if (typeof entityRef !== 'object') continue;
    const entity = scanMsg(u8, entityRef.pos, entityRef.pos + entityRef.len);

    // field 3 = trip_update
    if (!entity[3] || !entity[3][0] || typeof entity[3][0] !== 'object') continue;
    const tuRef = entity[3][0];
    const tu    = scanMsg(u8, tuRef.pos, tuRef.pos + tuRef.len);

    // field 1 = trip descriptor
    let tripId = "", routeId = "";
    if (tu[1] && typeof tu[1][0] === 'object') {
      const trip = scanMsg(u8, tu[1][0].pos, tu[1][0].pos + tu[1][0].len);
      if (trip[1] && typeof trip[1][0] === 'object') tripId  = str(u8, trip[1][0]);
      if (trip[5] && typeof trip[5][0] === 'object') routeId = str(u8, trip[5][0]);
    }

    // field 2 = stop_time_update (repeated)
    const stops = [];
    for (const stuRef of (tu[2] || [])) {
      if (typeof stuRef !== 'object') continue;
      const stu = scanMsg(u8, stuRef.pos, stuRef.pos + stuRef.len);

      // field 4 = stop_id (string) — confirmed always field 4
      let stopId = "";
      if (stu[4] && typeof stu[4][0] === 'object') stopId = str(u8, stu[4][0]);

      // field 2 = arrival (StopTimeEvent), field 2 inside = time
      const arrTs = (stu[2] && typeof stu[2][0] === 'object') ? scalarIn(u8, stu[2][0], 2) : 0;

      // field 3 = departure (StopTimeEvent), field 2 inside = time
      const depTs = (stu[3] && typeof stu[3][0] === 'object') ? scalarIn(u8, stu[3][0], 2) : 0;

      stops.push({ stopId, arrTs, depTs });
    }

    if (!stops.length) continue;

    // Only inbound: last stop must be GCT
    if (stops[stops.length - 1].stopId !== GCT_STOP_ID) continue;

    // Find Port Chester
    const pcIdx = stops.findIndex(s => s.stopId === STOP_ID);
    if (pcIdx < 0) continue;

    const pc    = stops[pcIdx];
    const depTs = pc.depTs || pc.arrTs;
    if (!depTs || depTs < now - 60) continue;

    const gct    = stops[stops.length - 1];
    const gctArr = gct.arrTs || gct.depTs || null;
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
  return new Date(ts * 1000).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZone: "America/New_York"
  });
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
