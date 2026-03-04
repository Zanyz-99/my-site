// netlify/functions/trains.js
// Zero dependencies — native protobuf decoder for GTFS-RT

const FEED_URL       = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr";
const STATION_NAME   = "Port Chester";
const STOP_ID        = "115";
const GCT_STOP_ID    = "1";
const WALK_MINUTES   = 10;
const BUFFER_MINUTES = 2;

// ── Protobuf decoder ──────────────────────────────────────────────────────────
function readVarint(u8, pos) {
  let result = 0n, shift = 0n;
  let b;
  do {
    b = u8[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return { value: result, pos };
}

function parseMsg(u8, start, end) {
  const fields = {};
  let pos = start;
  while (pos < end) {
    const tag = readVarint(u8, pos);
    pos = tag.pos;
    if (pos > end) break;
    const fieldNum = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (wireType === 0) {
      const v = readVarint(u8, pos);
      pos = v.pos;
      if (!(fieldNum in fields)) fields[fieldNum] = v.value;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const lenV = readVarint(u8, pos);
      pos = lenV.pos;
      const len = Number(lenV.value);
      if (!fields[fieldNum]) fields[fieldNum] = [];
      fields[fieldNum].push({ start: pos, end: pos + len });
      pos += len;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

const td = new TextDecoder();
function str(u8, ref) {
  if (!ref) return "";
  const r = Array.isArray(ref) ? ref[0] : ref;
  return td.decode(u8.slice(r.start, r.end));
}

function num(ref) {
  if (ref === undefined || ref === null) return 0;
  return Number(ref);
}

function first(fields, fieldNum) {
  const v = fields[fieldNum];
  if (!v) return null;
  return Array.isArray(v) ? v[0] : v;
}

function parseGtfsRt(buffer) {
  const u8  = new Uint8Array(buffer);
  const root = parseMsg(u8, 0, u8.length);
  const now  = Math.floor(Date.now() / 1000);
  const trains = [];

  // field 2 = repeated FeedEntity
  const entities = root[2] || [];
  for (const eRef of entities) {
    const e = parseMsg(u8, eRef.start, eRef.end);
    // field 3 = trip_update
    const tuRef = first(e, 3);
    if (!tuRef) continue;
    const tu = parseMsg(u8, tuRef.start, tuRef.end);

    // field 1 = trip descriptor
    const tripRef = first(tu, 1);
    const trip = tripRef ? parseMsg(u8, tripRef.start, tripRef.end) : {};
    // trip field 3 = trip_id, field 5 = route_id
    const tripId  = str(u8, first(trip, 3));
    const routeId = str(u8, first(trip, 5));

    // field 2 = repeated StopTimeUpdate
    const stus = tu[2] || [];
    if (!stus.length) continue;

    // Parse all stop time updates
    const stops = stus.map(sRef => {
      const s = parseMsg(u8, sRef.start, sRef.end);
      // field 3 = stop_id (string), field 1 = stop_sequence
      const stopId = str(u8, first(s, 3));
      // field 2 = arrival, field 3 = departure (StopTimeEvent: field 2 = time)
      const arrRef = first(s, 2);
      const depRef = first(s, 3);
      const arrTime = arrRef ? num(parseMsg(u8, arrRef.start, arrRef.end)[2]) : 0;
      const depTime = depRef ? num(parseMsg(u8, depRef.start, depRef.end)[2]) : 0;
      return { stopId, arrTime, depTime };
    });

    // Only inbound: last stop is GCT
    if (stops[stops.length - 1].stopId !== GCT_STOP_ID) continue;

    // Find Port Chester
    const pcIdx = stops.findIndex(s => s.stopId === STOP_ID);
    if (pcIdx === -1) continue;

    const pc = stops[pcIdx];
    const depTs = pc.depTime || pc.arrTime;
    if (!depTs || depTs < now - 300) continue;

    const gctStop = stops[stops.length - 1];
    const gctArr  = gctStop.arrTime || gctStop.depTime || null;
    const lvTs    = depTs - (WALK_MINUTES + BUFFER_MINUTES) * 60;

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

// ── Handler ───────────────────────────────────────────────────────────────────
export default async () => {
  try {
    const resp = await fetch(FEED_URL);
    if (!resp.ok) throw new Error(`MTA feed returned ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    const u8 = new Uint8Array(buffer);
    const root = parseMsg(u8, 0, u8.length);
    const entities = root[2] || [];

    const sample = [];
    for (const eRef of entities.slice(0, 3)) {
      const e = parseMsg(u8, eRef.start, eRef.end);
      const tuRef = first(e, 3);
      if (!tuRef) continue;
      const tu = parseMsg(u8, tuRef.start, tuRef.end);
      const stus = tu[2] || [];
      const firstStops = stus.slice(0, 3).map(sRef => {
        const s = parseMsg(u8, sRef.start, sRef.end);
        return str(u8, first(s, 3));
      });
      const lastStops = stus.slice(-3).map(sRef => {
        const s = parseMsg(u8, sRef.start, sRef.end);
        return str(u8, first(s, 3));
      });
      sample.push({ totalStops: stus.length, firstStops, lastStops });
    }

    return new Response(JSON.stringify({ entityCount: entities.length, sample }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

export const config = { path: "/api/trains" };
