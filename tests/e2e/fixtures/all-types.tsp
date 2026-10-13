// All-logical-types fixture for E2E import → emit → round-trip.
// Covers the scalar/temporal logical types plus enum and array.
@doc("Exercises every logical data type for mapping verification")
model AllTypes {
  @key id: string;
  str: string;
  flag: boolean;
  raw: bytes;

  i8: int8;
  i16: int16;
  i32: int32;
  i64: int64;
  u8: uint8;
  u16: uint16;
  u32: uint32;
  u64: uint64;
  safe: safeint;
  intAny: integer;
  num: numeric;

  f: float;
  f32: float32;
  f64: float64;
  dec128: decimal128;

  d: plainDate;
  t: plainTime;
  dt: utcDateTime;
  odt: offsetDateTime;
  dur: duration;

  status: Status;
  tags: string[];
}

enum Status {
  Active,
  Inactive,
}
