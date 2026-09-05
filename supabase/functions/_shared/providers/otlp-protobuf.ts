// OTLP/protobuf decoding for the logs signal.
//
// claude-otel never needed this: Claude Code is configured with
// OTEL_EXPORTER_OTLP_PROTOCOL=http/json and the payload arrives as JSON that
// request.json() already understands. Grok Build accepts only http/protobuf or
// grpc, and an unrecognized protocol disables its exporter outright rather than
// falling back — a hub configured for http/json receives nothing at all, with
// no error to notice. So the bytes are decoded here instead.
//
// The output is deliberately shaped like OTLP's own JSON encoding rather than
// something bespoke, so a parser written against either transport reads the
// same attributes by the same names.
//
// Only the fields the hub reads are decoded; anything else is skipped by wire
// type. An additive upstream change is therefore ignored rather than fatal,
// which matters for a schema its own documentation calls alpha.

export interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
}

export interface KeyValue {
  key?: string;
  value?: AnyValue;
}

export interface OtlpLogRecord {
  // Kept as a string. These are nanoseconds since the epoch, which is past the
  // point where a double stays exact, and the value doubles as a dedup key.
  timeUnixNano: string | null;
  observedTimeUnixNano: string | null;
  // OTLP 1.5 moved the event name onto its own field. Grok Build populates it
  // and leaves the body empty, so a reader that only checks body or an
  // event.name attribute sees every record as anonymous.
  eventName: string | null;
  body?: AnyValue;
  attributes: KeyValue[];
}

export interface OtlpResourceLogs {
  resourceAttributes: KeyValue[];
  logRecords: OtlpLogRecord[];
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

interface Cursor {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
  end: number;
}

function cursorFor(bytes: Uint8Array, offset = 0, end = bytes.length): Cursor {
  return {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset,
    end,
  };
}

// Token counts and enum values only. Accumulating into a double rather than a
// BigInt is exact below 2^53, which every field decoded this way stays under;
// the one field that does not — the nanosecond clock — is a fixed64 and is read
// as a BigInt instead.
function varint(cursor: Cursor) {
  let result = 0;
  let shift = 0;

  while (cursor.offset < cursor.end) {
    const byte = cursor.bytes[cursor.offset++];
    result += (byte & 0x7f) * 2 ** shift;

    if ((byte & 0x80) === 0) {
      return result;
    }

    shift += 7;
  }

  return result;
}

// Advances past a field the caller does not read, so an unknown field cannot
// desynchronize the rest of the message.
function skip(cursor: Cursor, wire: number) {
  if (wire === WIRE_VARINT) {
    varint(cursor);
    return;
  }

  if (wire === WIRE_FIXED64) {
    cursor.offset += 8;
    return;
  }

  if (wire === WIRE_FIXED32) {
    cursor.offset += 4;
    return;
  }

  if (wire === WIRE_LENGTH) {
    // Read the length before advancing: `offset += varint(cursor)` would
    // capture offset before varint moved it past the length prefix, and skip
    // the payload from the wrong place.
    const length = varint(cursor);
    cursor.offset += length;
    return;
  }

  // Groups were removed from proto3. Nothing can be skipped safely past an
  // unknown wire type, so the message ends here rather than being misread.
  cursor.offset = cursor.end;
}

// Walks one message, handing each field to `visit`. Returning without reading
// the field's value is what `skip` is for; `visit` reports whether it consumed
// the field so this loop can skip whatever it did not.
function walk(
  cursor: Cursor,
  visit: (field: number, wire: number, cursor: Cursor) => boolean,
) {
  while (cursor.offset < cursor.end) {
    const tag = varint(cursor);
    const field = tag >>> 3;
    const wire = tag & 7;

    if (!visit(field, wire, cursor)) {
      skip(cursor, wire);
    }
  }
}

function subCursor(cursor: Cursor) {
  const length = varint(cursor);
  const start = cursor.offset;
  const end = Math.min(start + length, cursor.end);
  cursor.offset = end;

  return cursorFor(cursor.bytes, start, end);
}

const decoder = new TextDecoder();

function utf8(cursor: Cursor) {
  const inner = subCursor(cursor);
  return decoder.decode(cursor.bytes.subarray(inner.offset, inner.end));
}

function fixed64(cursor: Cursor) {
  const value = cursor.view.getBigUint64(cursor.offset, true);
  cursor.offset += 8;
  return value;
}

function double(cursor: Cursor) {
  const value = cursor.view.getFloat64(cursor.offset, true);
  cursor.offset += 8;
  return value;
}

function decodeAnyValue(cursor: Cursor): AnyValue {
  const value: AnyValue = {};

  walk(cursor, (field, wire, inner) => {
    if (field === 1 && wire === WIRE_LENGTH) {
      value.stringValue = utf8(inner);
      return true;
    }

    if (field === 2 && wire === WIRE_VARINT) {
      value.boolValue = varint(inner) !== 0;
      return true;
    }

    if (field === 3 && wire === WIRE_VARINT) {
      value.intValue = varint(inner);
      return true;
    }

    if (field === 4 && wire === WIRE_FIXED64) {
      value.doubleValue = double(inner);
      return true;
    }

    // Arrays, kvlists and raw bytes are skipped rather than flattened. No
    // attribute the hub reads uses them, and inventing a text form for one
    // would put a shape into the database that upstream never sent.
    return false;
  });

  return value;
}

function decodeKeyValue(cursor: Cursor): KeyValue {
  const entry: KeyValue = {};

  walk(cursor, (field, wire, inner) => {
    if (field === 1 && wire === WIRE_LENGTH) {
      entry.key = utf8(inner);
      return true;
    }

    if (field === 2 && wire === WIRE_LENGTH) {
      entry.value = decodeAnyValue(subCursor(inner));
      return true;
    }

    return false;
  });

  return entry;
}

function decodeLogRecord(cursor: Cursor): OtlpLogRecord {
  const record: OtlpLogRecord = {
    timeUnixNano: null,
    observedTimeUnixNano: null,
    eventName: null,
    attributes: [],
  };

  walk(cursor, (field, wire, inner) => {
    if (field === 1 && wire === WIRE_FIXED64) {
      record.timeUnixNano = fixed64(inner).toString();
      return true;
    }

    if (field === 5 && wire === WIRE_LENGTH) {
      record.body = decodeAnyValue(subCursor(inner));
      return true;
    }

    if (field === 6 && wire === WIRE_LENGTH) {
      record.attributes.push(decodeKeyValue(subCursor(inner)));
      return true;
    }

    if (field === 11 && wire === WIRE_FIXED64) {
      record.observedTimeUnixNano = fixed64(inner).toString();
      return true;
    }

    if (field === 12 && wire === WIRE_LENGTH) {
      record.eventName = utf8(inner);
      return true;
    }

    return false;
  });

  return record;
}

function decodeResource(cursor: Cursor): KeyValue[] {
  const attributes: KeyValue[] = [];

  walk(cursor, (field, wire, inner) => {
    if (field === 1 && wire === WIRE_LENGTH) {
      attributes.push(decodeKeyValue(subCursor(inner)));
      return true;
    }

    return false;
  });

  return attributes;
}

function decodeScopeLogs(cursor: Cursor): OtlpLogRecord[] {
  const records: OtlpLogRecord[] = [];

  walk(cursor, (field, wire, inner) => {
    if (field === 2 && wire === WIRE_LENGTH) {
      records.push(decodeLogRecord(subCursor(inner)));
      return true;
    }

    return false;
  });

  return records;
}

function decodeResourceLogs(cursor: Cursor): OtlpResourceLogs {
  const group: OtlpResourceLogs = { resourceAttributes: [], logRecords: [] };

  walk(cursor, (field, wire, inner) => {
    if (field === 1 && wire === WIRE_LENGTH) {
      group.resourceAttributes = decodeResource(subCursor(inner));
      return true;
    }

    if (field === 2 && wire === WIRE_LENGTH) {
      group.logRecords.push(...decodeScopeLogs(subCursor(inner)));
      return true;
    }

    return false;
  });

  return group;
}

// Decodes an ExportLogsServiceRequest. A payload that is not one yields no
// groups rather than throwing: the exporter retries anything it does not see
// acknowledged, and a parse failure that 500s would put it into a retry loop
// over a batch that can never succeed.
export function decodeLogsRequest(bytes: Uint8Array): OtlpResourceLogs[] {
  const groups: OtlpResourceLogs[] = [];

  try {
    walk(cursorFor(bytes), (field, wire, inner) => {
      if (field === 1 && wire === WIRE_LENGTH) {
        groups.push(decodeResourceLogs(subCursor(inner)));
        return true;
      }

      return false;
    });
  } catch {
    return [];
  }

  return groups;
}
