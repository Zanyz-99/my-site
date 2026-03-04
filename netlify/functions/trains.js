// netlify/functions/trains.js
// Uses protobufjs/minimal via CDN-fetched descriptor — zero npm deps

const FEED_URL       = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr";
const STATION_NAME   = "Port Chester";
const STOP_ID        = "115";
const GCT_STOP_ID    = "1";
const WALK_MINUTES   = 10;
const BUFFER_MINUTES = 2;

// ── Minimal correct protobuf varint + length-delimited parser ─────────────────
// GTFS-RT field map (we only need these):
// FeedMessage: 2 = entity[]
// FeedEntity:  3 = trip_update
// TripUpdate:  1 = trip, 2 = stop_time_update[]
// TripDescriptor: 1 = trip_id, 5 = route_id
// StopTimeUpdate: 1 = stop_sequence, 3 = stop_id, 2 = arrival, 3 = departure
// StopTimeEvent:  2 = time (int64)

class PBReader {
  constructor(buf) {
    this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.pos = 0;
    this.end = this.b.length;
  }

  setRange(start, end) {
    this.pos = start;
    this.end = end;
    return this;
  }

  varint() {
    let lo = 0, hi = 0, shift = 0, b;
    while (shift < 28) {
      b = this.b[this.pos++];
      lo |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return lo >>> 0;
      shift += 7;
    }
    b = this.b[this.pos++];
    lo |= (b & 0x7f) << 28;
    hi  = (b & 0x7f) >> 4;
    while (this.pos < this.end) {
      b = this.b[this.pos++];
      hi |= (b & 0x7f) << (shift - 25);
      if (!(b & 0x80)) break;
      shift += 7;
    }
    // For timestamps (int64) return as number (safe up to 2^53)
    return (hi * 0x100000000 + (lo >>> 0));
  }

  skip(wireType) {
    if (wireType === 0) { this.varint(); }
    else if (wireType === 1) { this.pos += 8; }
    else if (wireType === 2) { this.pos += this.varint(); }
    else if (wireType === 5) { this.pos += 4; }
  }

  string(start, len) {
    return new TextDecoder().decode(this.b.slice(start, start + len));
  }

  // Parse a message in range [start, end), calling cb(fieldNum, wireType, reader)
  eachField(start, end, cb) {
    this.pos = start;
    this.end = end;
    while (this.pos < end) {
      const tag      = this.varint();
      const fieldNum = tag >>> 3;
      const wireType = tag & 0x7;
      cb(fieldNum, wireType, this);
    }
  }
}

function parseGtfsRt(buffer) {
  const r    = new PBReader(buffer);
  const now  = Math.floor(Date.now() / 1000);
  const trains = [];
  const total  = r.b.length;

  // FeedMessage field 2 = repeated FeedEntity
  r.eachField(0, total, (f, wt) => {
    if (f !== 2 || wt !== 2) { r.skip(wt); return; }
    const eLen   = r.varint();
    const eStart = r.pos;
    const eEnd   = eStart + eLen;
    r.pos = eEnd; // advance outer reader past this entity

    // Parse FeedEntity — field 3 = TripUpdate
    let tuStart = -1, tuLen = 0;
    r.eachField(eStart, eEnd, (f2, wt2) => {
      if (f2 === 3 && wt2 === 2) {
        tuLen   = r.varint();
        tuStart = r.pos;
        r.pos   = tuStart + tuLen;
      } else {
        r.skip(wt2);
      }
    });
    if (tuStart < 0) return;

    // Parse TripUpdate
    // field 1 = TripDescriptor, field 2 = repeated StopTimeUpdate
    let tripId = "", routeId = "";
    const stops = []; // {stopId, depTs, arrTs}

    r.eachField(tuStart, tuStart + tuLen, (f2, wt2) => {
      if (f2 === 1 && wt2 === 2) {
        // TripDescriptor
        const tdLen   = r.varint();
        const tdStart = r.pos;
        r.pos = tdStart + tdLen;
        r.eachField(tdStart, tdStart + tdLen, (f3, wt3) => {
          if (f3 === 3 && wt3 === 2) { // trip_id
            const sLen = r.varint(); tripId = r.string(r.pos, sLen); r.pos += sLen;
          } else if (f3 === 5 && wt3 === 2) { // route_id
            const sLen = r.varint(); routeId = r.string(r.pos, sLen); r.pos += sLen;
          } else { r.skip(wt3); }
        });
      } else if (f2 === 2 && wt2 === 2) {
        // StopTimeUpdate
        const stuLen   = r.varint();
        const stuStart = r.pos;
        r.pos = stuStart + stuLen;

        let stopId = "", arrTs = 0, depTs = 0;
        r.eachField(stuStart, stuStart + stuLen, (f3, wt3) => {
          if (f3 === 3 && wt3 === 2) { // stop_id
            const sLen = r.varint(); stopId = r.string(r.pos, sLen); r.pos += sLen;
          } else if (f3 === 2 && wt3 === 2) { // arrival StopTimeEvent
            const evLen   = r.varint();
            const evStart = r.pos;
            r.pos = evStart + evLen;
            r.eachField(evStart, evStart + evLen, (f4, wt4) => {
              if (f4 === 2 && wt4 === 0) arrTs = r.varint();
              else r.skip(wt4);
            });
          } else if (f3 === 3 && wt3 === 2) { // departure StopTimeEvent
            // Note: field 3 is also stop_id (string) vs departure (message)
            // wire type disambiguates: stop_id=string(wt2), departure=message(wt2)
            // Both are wt=2 so we need to check if we already have stopId
            // Actually in protobuf stop_id is field 4 in some versions — handle below
            const evLen   = r.varint();
            const evStart = r.pos;
            r.pos = evStart + evLen;
            r.eachField(evStart, evStart + evLen, (f4, wt4) => {
              if (f4 === 2 && wt4 === 0) depTs = r.varint();
              else r.skip(wt4);
            });
          } else if (f3 === 4 && wt3 === 2) { // stop_id is field 4 in GTFS-RT v2
            const sLen = r.varint(); stopId = r.string(r.pos, sLen); r.pos += sLen;
          } else { r.skip(wt3); }
        });
        stops.push({ stopId, arrTs, depTs });
      } else {
        r.skip(wt2);
      }
    });

    if (!stops.length) return;

    // Only inbound: last stop = GCT
    if (stops[stops.length - 1].stopId !== GCT_STOP_ID) return;

    // Find Port Chester
    const pcIdx = stops.findIndex(s => s.stopId === STOP_ID);
    if (pcIdx < 0) return;

    const pc    = stops[pcIdx];
    const depTs = pc.depTs || pc.arrTs;
    if (!depTs || depTs < now - 300) return;

    const gct   = stops[stops.length - 1];
    const gctArr = gct.arrTs || gct.depTs || null;
    const lvTs  = depTs - (WALK_MINUTES + BUFFER_MINUTES) * 60;

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
  });

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
        "Content-Type":                "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control":               "no-store",
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
